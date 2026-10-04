#!/usr/bin/env bash
# Self-deploy for FinTekkers/valuation-service (Rust gRPC server) on this host.
# Called by Horizon's release webhook with the release tag; same contract as
# deploy-ui-service.sh: lock, fetch, check out the tag, build, restart the
# systemd unit, health-check, then record last-good-tag and DEPLOY OK in
# $STATE_DIR/self-deploy.log (or DEPLOY FAILED: <stage>).
#
# The server listens on 127.0.0.1:8090 (PORT/IPV4 in the unit; 8080 is the
# WhatsApp bridge on this host). Health is the standard gRPC health check
# (grpc.health.v1.Health/Check, which the server registers via tonic-health),
# sent with curl over HTTP/2 cleartext; a SERVING reply is healthy.
set -euo pipefail
# The webhook runs this from horizon-server, whose PATH lacks rustup's bin.
export PATH="$HOME/.cargo/bin:$PATH"

TAG="${1:-}"

# Overridable for the test harness (infra/host/test/deploy.test.sh), which
# points these at a throwaway repo and stubbed commands instead of the real
# host paths/service. Defaults below are what production actually uses.
REPO_DIR="${HORIZON_REPO_DIR:-/opt/fintekkers/valuation-service}"
STATE_DIR="${HORIZON_STATE_DIR:-$HOME/.horizon/valuation-service}"
SERVICE_NAME="${HORIZON_SERVICE_NAME:-fintekkers-valuation}"
HEALTH_URL="${HORIZON_HEALTH_URL:-http://127.0.0.1:8090/}"
HEALTH_TIMEOUT_S="${HORIZON_HEALTH_TIMEOUT_S:-60}"
HEALTH_POLL_S="${HORIZON_HEALTH_POLL_S:-2}"
LOCK_TIMEOUT_S="${HORIZON_DEPLOY_LOCK_TIMEOUT_S:-300}"

mkdir -p "$STATE_DIR"
LOCK_FILE="$STATE_DIR/deploy.lock"
LOG_FILE="$STATE_DIR/self-deploy.log"
LAST_GOOD_FILE="$STATE_DIR/last-good-tag"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"$LOG_FILE"
}

STAGE="lock"
on_error() {
  log "DEPLOY FAILED: ${STAGE} (tag=${TAG:-origin/main})"
}
trap on_error ERR

exec 9>"$LOCK_FILE"
if ! flock -w "$LOCK_TIMEOUT_S" 9; then
  log "DEPLOY FAILED: lock (tag=${TAG:-origin/main}) — another deploy held it past ${LOCK_TIMEOUT_S}s"
  exit 1
fi

STAGE="fetch"
cd "$REPO_DIR"
git fetch --tags origin

STAGE="checkout"
if [ -n "$TAG" ] && git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  REF="refs/tags/$TAG"
else
  REF="origin/main"
fi
git checkout --detach "$REF"
COMMIT="$(git rev-parse HEAD)"

STAGE="build"
cargo build --release --bin valuation-service-server

STAGE="restart"
sudo systemctl restart "$SERVICE_NAME"

# ui-service is adapter-node SSR: `GET /` always returns 200 from the running
# process even when build/client is stale, partially written, or missing
# entirely, because the page is rendered server-side while the referenced
# client assets 404 underneath it (observed live on this host after an
# in-place rebuild — the old build stayed in memory while build/ was gone on
# disk). A bare status check can't catch that, so this mirrors
# deploy-horizon.sh's ui-build-verify in spirit but runs it against the
# actually-served output instead of the on-disk build: (1) the page serves at
# all, (2) the SSR body is really the app shell and not an error page, (3)
# the specific client bundle THIS html references is really being served.
# Check 3 is self-maintaining — it reads whichever asset hash the current
# build emitted, so it can never go stale the way a hardcoded filename would.
STAGE="health-check"
healthy=""
health_error=""
origin="${HEALTH_URL%/}"
deadline=$((SECONDS + HEALTH_TIMEOUT_S))
while [ "$SECONDS" -lt "$deadline" ]; do
  # Empty HealthCheckRequest as one gRPC frame: 0x00 flag + 4-byte length 0.
  if reply="$(printf '\x00\x00\x00\x00\x00' | curl -sS --http2-prior-knowledge --max-time 5 \
      -H 'content-type: application/grpc' -H 'te: trailers' --data-binary @- \
      "$origin/grpc.health.v1.Health/Check" 2>&1 | od -An -tx1 | tr -d ' \n')"; then
    # Reply frame 00 00000002 0801 = HealthCheckResponse{status: SERVING}.
    if [ "$reply" = "00000000020801" ]; then
      healthy=1
      break
    fi
    health_error="gRPC health reply was not SERVING (bytes: ${reply:-none})"
  else
    health_error="$reply"
  fi
  sleep "$HEALTH_POLL_S"
done
if [ -z "$healthy" ]; then
  log "DEPLOY FAILED: health-check (tag=${REF} commit=${COMMIT}) — ${HEALTH_URL}: ${health_error}"
  exit 1
fi

printf '%s:%s\n' "$REF" "$COMMIT" >"$LAST_GOOD_FILE"
log "DEPLOY OK tag=${REF} commit=${COMMIT}"
