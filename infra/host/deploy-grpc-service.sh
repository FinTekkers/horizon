#!/usr/bin/env bash
# Shared self-deploy for the FinTekkers gRPC backends on this host. Not a
# deploy target itself: each deploy-<service>.sh wrapper sets the DEPLOY_*
# variables below and execs this with the release tag. Same contract as
# deploy-ui-service.sh: lock, fetch, check out the tag, build, restart the
# systemd unit, health-check, then record last-good-tag and DEPLOY OK in
# $STATE_DIR/self-deploy.log (or DEPLOY FAILED: <stage>).
#
#   DEPLOY_NAME        state dir name under ~/.horizon/
#   DEPLOY_REPO_DIR    checkout the service runs from
#   DEPLOY_SERVICE     systemd unit (must be in horizon-deploy.sudoers)
#   DEPLOY_HEALTH_URL  http://host:port/ of the gRPC server
#   DEPLOY_BUILD       build command, run with bash -c in the checkout
#   DEPLOY_DEFAULT_REF ref to deploy when the tag is unknown (origin/main)
#   DEPLOY_HEALTH_TIMEOUT_S  how long the server may take to report SERVING
#
# Rollback: when the health check fails after the restart, the script checks
# out the last-good-tag commit (detached, no fetch), rebuilds, restarts and
# health-checks it once with the same timeout, still under the deploy lock.
# It logs ROLLBACK OK tag=<last good> after <failed>, ROLLBACK FAILED (<stage>)
# or, with no last-good-tag, ROLLBACK SKIPPED. Either way the run exits 1 and
# never rewrites last-good-tag. Failures before the restart never roll back.
#
# Health is the standard gRPC health check (grpc.health.v1.Health/Check, which
# every one of these servers registers), sent with curl over HTTP/2
# cleartext; a SERVING reply is healthy.
set -euo pipefail
# The webhook runs this from horizon-server, whose PATH lacks rustup's bin.
export PATH="$HOME/.cargo/bin:$PATH"

TAG="${1:-}"

: "${DEPLOY_NAME:?set by the deploy-<service>.sh wrapper}"
: "${DEPLOY_REPO_DIR:?set by the deploy-<service>.sh wrapper}"
: "${DEPLOY_SERVICE:?set by the deploy-<service>.sh wrapper}"
: "${DEPLOY_HEALTH_URL:?set by the deploy-<service>.sh wrapper}"
: "${DEPLOY_BUILD:?set by the deploy-<service>.sh wrapper}"

# Overridable for the test harness (infra/host/test/deploy-grpc-service.test.sh),
# which points these at a throwaway repo and stubbed commands.
REPO_DIR="${HORIZON_REPO_DIR:-$DEPLOY_REPO_DIR}"
STATE_DIR="${HORIZON_STATE_DIR:-$HOME/.horizon/$DEPLOY_NAME}"
SERVICE_NAME="${HORIZON_SERVICE_NAME:-$DEPLOY_SERVICE}"
HEALTH_URL="${HORIZON_HEALTH_URL:-$DEPLOY_HEALTH_URL}"
DEFAULT_REF="${DEPLOY_DEFAULT_REF:-origin/main}"
HEALTH_TIMEOUT_S="${HORIZON_HEALTH_TIMEOUT_S:-${DEPLOY_HEALTH_TIMEOUT_S:-60}}"
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
  log "DEPLOY FAILED: ${STAGE} (tag=${TAG:-$DEFAULT_REF})"
}
trap on_error ERR

exec 9>"$LOCK_FILE"
if ! flock -w "$LOCK_TIMEOUT_S" 9; then
  log "DEPLOY FAILED: lock (tag=${TAG:-$DEFAULT_REF}) — another deploy held it past ${LOCK_TIMEOUT_S}s"
  exit 1
fi

STAGE="fetch"
cd "$REPO_DIR"
git fetch --tags origin

STAGE="checkout"
if [ -n "$TAG" ] && git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  REF="refs/tags/$TAG"
else
  REF="$DEFAULT_REF"
fi
git checkout --detach "$REF"
COMMIT="$(git rev-parse HEAD)"

STAGE="build"
bash -c "$DEPLOY_BUILD"

STAGE="restart"
sudo systemctl restart "$SERVICE_NAME"

STAGE="health-check"
health_error=""
# wait_healthy — polls the health check until SERVING (returns 0) or
# HEALTH_TIMEOUT_S passes (returns 1, health_error says why). Call it only
# from an if test so a timeout does not fire the ERR trap.
wait_healthy() {
  local origin reply deadline
  origin="${HEALTH_URL%/}"
  deadline=$((SECONDS + HEALTH_TIMEOUT_S))
  while [ "$SECONDS" -lt "$deadline" ]; do
    # Empty HealthCheckRequest as one gRPC frame: 0x00 flag + 4-byte length 0.
    if reply="$(printf '\x00\x00\x00\x00\x00' | curl -sS --http2-prior-knowledge --max-time 5 \
        -H 'content-type: application/grpc' -H 'te: trailers' --data-binary @- \
        "$origin/grpc.health.v1.Health/Check" 2>&1 | od -An -tx1 | tr -d ' \n')"; then
      # Reply frame 00 00000002 0801 = HealthCheckResponse{status: SERVING}.
      if [ "$reply" = "00000000020801" ]; then
        return 0
      fi
      health_error="gRPC health reply was not SERVING (bytes: ${reply:-none})"
    else
      health_error="$reply"
    fi
    sleep "$HEALTH_POLL_S"
  done
  return 1
}

# read_last_good — splits last-good-tag (<ref>:<commit>) into LAST_GOOD_REF
# and LAST_GOOD_COMMIT. Returns 1 when the file is missing or malformed.
LAST_GOOD_REF=""
LAST_GOOD_COMMIT=""
read_last_good() {
  local line=""
  [ -f "$LAST_GOOD_FILE" ] || return 1
  IFS= read -r line <"$LAST_GOOD_FILE" || [ -n "$line" ] || return 1
  case "$line" in *:*) ;; *) return 1 ;; esac
  LAST_GOOD_REF="${line%%:*}"
  LAST_GOOD_COMMIT="${line#*:}"
  [ -n "$LAST_GOOD_REF" ] && [ -n "$LAST_GOOD_COMMIT" ]
}

# rollback_failed STAGE [DETAIL] — logs and echoes the one ROLLBACK FAILED line.
rollback_failed() {
  local msg="ROLLBACK FAILED (${1}) tag=${LAST_GOOD_REF} after ${REF}${2:+ — $2}"
  log "$msg"
  echo "$msg" >&2
  return 1
}

# rollback — one attempt to put LAST_GOOD_COMMIT back: checkout, build,
# restart, health-check. Called only from the deploy's health-failure branch,
# inside an if test, so set -e and the ERR trap stay out of it; it never
# loops, never writes last-good-tag and never logs DEPLOY OK. If the last good
# commit is the one that just failed (a re-deploy), it still tries once.
rollback() {
  STAGE="rollback-checkout"
  if ! git cat-file -e "${LAST_GOOD_COMMIT}^{commit}" 2>/dev/null \
      || ! git checkout --detach "$LAST_GOOD_COMMIT"; then
    rollback_failed "$STAGE"
    return 1
  fi
  STAGE="rollback-build"
  if ! bash -c "$DEPLOY_BUILD"; then
    rollback_failed "$STAGE"
    return 1
  fi
  STAGE="rollback-restart"
  if ! sudo systemctl restart "$SERVICE_NAME"; then
    rollback_failed "$STAGE"
    return 1
  fi
  STAGE="rollback-health-check"
  health_error=""
  if ! wait_healthy; then
    rollback_failed "$STAGE" "${HEALTH_URL}: ${health_error}"
    return 1
  fi
  local msg="ROLLBACK OK tag=${LAST_GOOD_REF} after ${REF}"
  log "$msg"
  echo "$msg" >&2
}

if ! wait_healthy; then
  if ! read_last_good; then
    log "DEPLOY FAILED: health-check (tag=${REF} commit=${COMMIT}) — ${HEALTH_URL}: ${health_error}; cannot roll back: no last-good-tag"
    msg="ROLLBACK SKIPPED: no last-good-tag (after ${REF})"
    log "$msg"
    echo "$msg" >&2
    exit 1
  fi
  log "DEPLOY FAILED: health-check (tag=${REF} commit=${COMMIT}) — ${HEALTH_URL}: ${health_error}; rolling back to ${LAST_GOOD_REF}"
  # The deploy failed whatever the rollback did; one attempt, no retry.
  rollback || true
  exit 1
fi

printf '%s:%s\n' "$REF" "$COMMIT" >"$LAST_GOOD_FILE"
log "DEPLOY OK tag=${REF} commit=${COMMIT}"
