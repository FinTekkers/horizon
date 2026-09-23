#!/usr/bin/env bash
# Pull-based self-deploy for the Horizon target (infra/host/deploy-targets.json,
# key "horizon"). Invoked by the "release published" webhook
# (server/src/deploy.js) with the release tag as $1; falls back to
# origin/main if no tag is given or it doesn't resolve. Also usable by hand
# for rollback: deploy-horizon.sh $(cat ~/.horizon/horizon/last-good-tag | cut -d: -f1).
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
REPO_DIR="${HORIZON_REPO_DIR:-/opt/horizon}"
STATE_DIR="${HORIZON_STATE_DIR:-$HOME/.horizon}"
SERVICE_NAME="${HORIZON_SERVICE_NAME:-horizon-server}"
HEALTH_URL="${HORIZON_HEALTH_URL:-http://127.0.0.1:3001/api/health}"
HEALTH_TIMEOUT_S="${HORIZON_HEALTH_TIMEOUT_S:-30}"
HEALTH_POLL_S="${HORIZON_HEALTH_POLL_S:-2}"
LOCK_TIMEOUT_S="${HORIZON_DEPLOY_LOCK_TIMEOUT_S:-300}"

mkdir -p "$STATE_DIR"
LOCK_FILE="$STATE_DIR/deploy.lock"
LOG_FILE="$STATE_DIR/self-deploy.log"
LAST_GOOD_FILE="$STATE_DIR/last-good-tag"
LAST_ATTEMPTED_FILE="$STATE_DIR/last-attempted-tag"

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

# Recorded unconditionally, before anything that can fail below, so a failed
# deploy still leaves a diagnosable trail of what it was attempting — separate
# from LAST_GOOD_FILE, which stays the rollback target and is only written
# once the health check actually passes.
printf '%s:%s\n' "$REF" "$COMMIT" >"$LAST_ATTEMPTED_FILE"

STAGE="server-deps"
(cd server && npm ci)

STAGE="ui-build"
(cd ui && npm ci && HORIZON_BASE=/horizon/ npm run build)

STAGE="ui-build-verify"
if ! grep -q '/horizon/assets/' ui/dist/index.html; then
  log "DEPLOY FAILED: ${STAGE} (tag=${REF} commit=${COMMIT}) — ui/dist/index.html does not reference /horizon/assets/, HORIZON_BASE likely didn't reach the build"
  exit 1
fi

STAGE="restart"
sudo systemctl restart "$SERVICE_NAME"

STAGE="health-check"
healthy=""
health_error=""
deadline=$((SECONDS + HEALTH_TIMEOUT_S))
while [ "$SECONDS" -lt "$deadline" ]; do
  if body="$(curl -fsS "$HEALTH_URL" 2>&1)"; then
    # Piped via stdin, not argv: real snapshots run well past Linux's ~128KB
    # single-argument limit and a large body here used to fail curl's own
    # invocation with "Argument list too long" (rc 126), which then got
    # misreported as "never returned a valid items array".
    if health_error="$(printf '%s' "$body" | node -e '
        let input = ""
        process.stdin.on("data", (chunk) => { input += chunk })
        process.stdin.on("end", () => {
          let parsed
          try {
            parsed = JSON.parse(input)
          } catch (err) {
            console.error(`response is not valid JSON: ${err.message}`)
            process.exit(1)
          }
          if (parsed.ok === true && Number.isInteger(parsed.itemCount)) process.exit(0)
          console.error("response JSON missing ok:true/itemCount")
          process.exit(1)
        })
      ' 2>&1)"; then
      healthy=1
      break
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
