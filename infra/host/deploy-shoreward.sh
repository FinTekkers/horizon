#!/usr/bin/env bash
# Pull-based self-deploy for the shoreward target (repo FinTekkers/shoreward).
# shoreward.ai is a static Vite site that nginx serves from $REPO_DIR/dist, plus
# one dynamic route: nginx proxies POST /api/contact to shoreward-contact.service,
# which runs the repo's api/contact.js through infra/host/shoreward-contact.mjs.
#
# Invoked by the deploy with the release tag as $1; falls back to origin/main
# if no tag is given or it doesn't resolve. Also usable by hand for rollback:
# deploy-shoreward.sh $(cut -d: -f1 ~/.horizon/shoreward/last-good-tag).
#
# The repo's own scripts/deploy.sh uploads to S3 + CloudFront; that is not
# where shoreward.ai is served from (DNS points at this host), so it is never
# called here.
#
# The new build goes to dist.new and is swapped in with two renames, so nginx
# never serves a half-written dist/. A failed health check swaps the previous
# dist back, restarts the contact service on the previous code and exits
# non-zero with the failure in the log.
set -euo pipefail

TAG="${1:-}"

# Overridable for the test harness (infra/host/test/deploy-shoreward.test.sh).
REPO_DIR="${HORIZON_REPO_DIR:-/opt/shoreward}"
STATE_DIR="${HORIZON_STATE_DIR:-$HOME/.horizon/shoreward}"
SERVICE_NAME="${HORIZON_SERVICE_NAME:-shoreward-contact}"
HEALTH_URL="${HORIZON_HEALTH_URL:-https://shoreward.ai/}"
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
  # A failed checkout or build leaves the served dist untouched; put the code
  # back too, so the contact service's next restart runs what was live.
  if [ -n "${PREV_COMMIT:-}" ] && { [ "$STAGE" = "checkout" ] || [ "$STAGE" = "build" ]; }; then
    rm -rf "$REPO_DIR/dist.new"
    git -C "$REPO_DIR" checkout -q --detach "$PREV_COMMIT" || true
  fi
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
PREV_COMMIT="$(git rev-parse HEAD)"

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
rm -rf dist.new
npx vite build --outDir dist.new --emptyOutDir
for page in index.html contact.html; do
  if [ ! -s "dist.new/$page" ]; then
    log "DEPLOY FAILED: build (tag=${REF} commit=${COMMIT}) — dist.new/$page missing or empty"
    rm -rf dist.new
    git checkout --detach "$PREV_COMMIT"
    exit 1
  fi
done

STAGE="swap"
rm -rf dist.old
if [ -d dist ]; then mv dist dist.old; fi
mv dist.new dist

STAGE="restart"
sudo systemctl restart "$SERVICE_NAME"

# Three checks against what is actually served: the page loads, it is the
# Shoreward page (its <title>), and the JS bundle THIS html references is
# served — a stale or half-swapped dist fails the third.
STAGE="health-check"
healthy=""
health_error=""
deadline=$((SECONDS + HEALTH_TIMEOUT_S))
while [ "$SECONDS" -lt "$deadline" ]; do
  if body="$(curl -fsS "$HEALTH_URL" 2>&1)"; then
    # Here-strings, not `printf | grep -q`: see deploy-ui-service.sh (pipefail).
    if ! grep -qi '<title>shoreward' <<<"$body"; then
      health_error="response body has no <title>shoreward"
      sleep "$HEALTH_POLL_S"
      continue
    fi
    asset_path="$(grep -oE '/assets/[A-Za-z0-9_./-]+\.js' <<<"$body" | sed -n 1p || true)"
    if [ -z "$asset_path" ]; then
      health_error="response body references no /assets/*.js bundle"
      sleep "$HEALTH_POLL_S"
      continue
    fi
    origin="$(printf '%s' "$HEALTH_URL" | sed -E 's#(https?://[^/]+).*#\1#')"
    if ! asset_status="$(curl -fsS -o /dev/null -w '%{http_code}' "$origin$asset_path" 2>&1)"; then
      health_error="referenced bundle $asset_path did not return 200: $asset_status"
      sleep "$HEALTH_POLL_S"
      continue
    fi
    if ! systemctl is-active --quiet "$SERVICE_NAME"; then
      health_error="$SERVICE_NAME is not active after restart"
      sleep "$HEALTH_POLL_S"
      continue
    fi
    healthy=1
    break
  else
    health_error="$body"
  fi
  sleep "$HEALTH_POLL_S"
done
if [ -z "$healthy" ]; then
  log "DEPLOY FAILED: health-check (tag=${REF} commit=${COMMIT}) — ${HEALTH_URL}: ${health_error}"
  # Roll back: the previous build and code, so the site keeps serving.
  if [ -d dist.old ]; then
    rm -rf dist
    mv dist.old dist
  fi
  git checkout --detach "$PREV_COMMIT"
  sudo systemctl restart "$SERVICE_NAME" || true
  log "ROLLED BACK to commit=${PREV_COMMIT}"
  exit 1
fi

rm -rf dist.old
printf '%s:%s\n' "$REF" "$COMMIT" >"$LAST_GOOD_FILE"
log "DEPLOY OK tag=${REF} commit=${COMMIT}"
