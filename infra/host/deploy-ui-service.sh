#!/usr/bin/env bash
# Pull-based self-deploy for the ui-service target (infra/host/deploy-targets.json,
# key "ui-service", repo FinTekkers/ui-service). Invoked by the "release
# published" webhook (server/src/deploy.js) with the release tag as $1; falls
# back to origin/main if no tag is given or it doesn't resolve. Also usable by
# hand for rollback: deploy-ui-service.sh $(cat ~/.horizon/ui-service/last-good-tag | cut -d: -f1).
#
# Serialized by an flock around the whole run so overlapping webhook
# deliveries never race each other. Every attempt — success or failure — is
# appended to $STATE_DIR/self-deploy.log; a failed health-check after restart
# exits non-zero and leaves the failure in the log rather than retrying
# forever or rolling back silently.
set -euo pipefail

TAG="${1:-}"

# Overridable for the test harness (infra/host/test/deploy.test.sh), which
# points these at a throwaway repo and stubbed commands instead of the real
# host paths/service. Defaults below are what production actually uses.
REPO_DIR="${HORIZON_REPO_DIR:-/opt/fintekkers/ui-service}"
STATE_DIR="${HORIZON_STATE_DIR:-$HOME/.horizon/ui-service}"
SERVICE_NAME="${HORIZON_SERVICE_NAME:-fintekkers-ui}"
HEALTH_URL="${HORIZON_HEALTH_URL:-https://www.fintekkers.org/}"
HEALTH_TIMEOUT_S="${HORIZON_HEALTH_TIMEOUT_S:-30}"
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
npm ci
npm run build

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
deadline=$((SECONDS + HEALTH_TIMEOUT_S))
while [ "$SECONDS" -lt "$deadline" ]; do
  if body="$(curl -fsS "$HEALTH_URL" 2>&1)"; then
    if ! printf '%s' "$body" | grep -q '<title>Fintekkers'; then
      health_error="response body has no <title>Fintekkers — SSR did not render the app shell"
      sleep "$HEALTH_POLL_S"
      continue
    fi
    asset_path="$(printf '%s' "$body" | grep -oE '/_app/immutable/[A-Za-z0-9_./-]+\.js' | head -n1)"
    if [ -z "$asset_path" ]; then
      health_error="response body references no /_app/immutable/*.js client bundle"
      sleep "$HEALTH_POLL_S"
      continue
    fi
    origin="$(printf '%s' "$HEALTH_URL" | sed -E 's#(https?://[^/]+).*#\1#')"
    if asset_status="$(curl -fsS -o /dev/null -w '%{http_code}' "$origin$asset_path" 2>&1)"; then
      healthy=1
      break
    else
      health_error="referenced client bundle $asset_path did not return 200: $asset_status"
    fi
  else
    health_error="$body"
  fi
  sleep "$HEALTH_POLL_S"
done
if [ -z "$healthy" ]; then
  log "DEPLOY FAILED: health-check (tag=${REF} commit=${COMMIT}) — ${HEALTH_URL}: ${health_error}"
  exit 1
fi

printf '%s:%s\n' "$REF" "$COMMIT" >"$LAST_GOOD_FILE"
log "DEPLOY OK tag=${REF} commit=${COMMIT}"
