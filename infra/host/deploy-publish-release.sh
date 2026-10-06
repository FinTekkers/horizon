#!/usr/bin/env bash
# Shared self-deploy for libraries that GitHub Actions publishes to package
# registries when a version tag (vX.Y.Z) is pushed. Not a deploy target
# itself: each deploy-<library>.sh wrapper sets the DEPLOY_* variables below
# and execs this with Horizon's release tag (e.g. deploy-lm-113).
#
# A deploy here is a version bump: the release tag's commit gets the next
# patch version tag (v0.4.12 -> v0.4.13; a rerun reuses the version tag the
# commit already has), which starts the repo's publish workflows. The deploy
# is good once every DEPLOY_REQUIRED_WORKFLOWS run for that version tag has
# succeeded and every DEPLOY_STARTED_WORKFLOWS run exists without having
# failed (Maven Central can take hours). Same log contract as the other
# deploy scripts: last-good-tag and DEPLOY OK in $STATE_DIR/self-deploy.log,
# or DEPLOY FAILED: <stage>.
#
#   DEPLOY_NAME                state dir name under ~/.horizon/
#   DEPLOY_REPO_DIR            a clone of the library (tags are pushed from it)
#   DEPLOY_GITHUB_REPO         owner/name, for the Actions API
#   DEPLOY_REQUIRED_WORKFLOWS  workflow files that must succeed
#   DEPLOY_STARTED_WORKFLOWS   workflow files that must start and not fail
#   DEPLOY_PUBLISH_TIMEOUT_S   how long to wait for the workflows
set -euo pipefail

TAG="${1:-}"

: "${DEPLOY_NAME:?set by the deploy-<library>.sh wrapper}"
: "${DEPLOY_REPO_DIR:?set by the deploy-<library>.sh wrapper}"
: "${DEPLOY_GITHUB_REPO:?set by the deploy-<library>.sh wrapper}"
: "${DEPLOY_REQUIRED_WORKFLOWS:?set by the deploy-<library>.sh wrapper}"

# Overridable for the test harness (infra/host/test/deploy-publish-release.test.sh).
REPO_DIR="${HORIZON_REPO_DIR:-$DEPLOY_REPO_DIR}"
STATE_DIR="${HORIZON_STATE_DIR:-$HOME/.horizon/$DEPLOY_NAME}"
GITHUB_API="${HORIZON_GITHUB_API:-https://api.github.com}"
PUBLISH_TIMEOUT_S="${HORIZON_PUBLISH_TIMEOUT_S:-${DEPLOY_PUBLISH_TIMEOUT_S:-900}}"
POLL_S="${HORIZON_PUBLISH_POLL_S:-20}"
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
  log "DEPLOY FAILED: ${STAGE} (tag=${TAG:-none})"
}
trap on_error ERR

exec 9>"$LOCK_FILE"
if ! flock -w "$LOCK_TIMEOUT_S" 9; then
  log "DEPLOY FAILED: lock (tag=${TAG:-none}) — another deploy held it past ${LOCK_TIMEOUT_S}s"
  exit 1
fi

STAGE="fetch"
cd "$REPO_DIR"
git fetch --tags --force origin

# A library has nothing to fall back to: publishing whatever main is would
# release code no item was verified against.
STAGE="resolve"
if [ -z "$TAG" ] || ! COMMIT="$(git rev-parse -q --verify "refs/tags/$TAG^{commit}")"; then
  log "DEPLOY FAILED: resolve (tag=${TAG:-none}) — no such release tag"
  exit 1
fi

STAGE="version"
VERSION="$(git tag --points-at "$COMMIT" -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n1)"
if [ -z "$VERSION" ]; then
  latest="$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n1)"
  if [ -z "$latest" ]; then
    log "DEPLOY FAILED: version (tag=refs/tags/${TAG} commit=${COMMIT}) — no vX.Y.Z tag to increment"
    exit 1
  fi
  IFS=. read -r major minor patch <<<"${latest#v}"
  VERSION="v${major}.${minor}.$((patch + 1))"
  STAGE="push-tag"
  git push origin "${COMMIT}:refs/tags/${VERSION}"
  log "tagged ${VERSION} on ${COMMIT} (was ${latest}) — publish workflows start from this push"
else
  log "${COMMIT} already carries ${VERSION} — checking its publish workflows"
fi

STAGE="publish"
TOKEN="${HORIZON_GITHUB_TOKEN:-$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p')}"
if [ -z "$TOKEN" ]; then
  log "DEPLOY FAILED: publish (tag=refs/tags/${TAG} commit=${COMMIT}) — no GitHub credential to read the workflow runs"
  exit 1
fi

# Prints "ok", "wait <why>" or "fail <why>" for the runs on $VERSION.
publish_state() {
  curl -sS --max-time 20 -H "Authorization: Bearer $TOKEN" -H 'Accept: application/vnd.github+json' \
    "$GITHUB_API/repos/$DEPLOY_GITHUB_REPO/actions/runs?event=push&branch=$VERSION&per_page=50" |
    REQUIRED="$DEPLOY_REQUIRED_WORKFLOWS" STARTED="${DEPLOY_STARTED_WORKFLOWS:-}" python3 -c '
import json, os, sys
try:
    runs = json.load(sys.stdin)["workflow_runs"]
except Exception:
    print("wait the Actions API reply was not readable"); sys.exit()
latest = {}
for run in runs:  # newest first: keep the newest run of each workflow file
    latest.setdefault(run.get("path", "").rsplit("/", 1)[-1], run)
waiting = []
for name in os.environ["REQUIRED"].split():
    run = latest.get(name)
    if run is None:
        waiting.append(f"{name} not started")
    elif run["status"] != "completed":
        waiting.append(name + " " + run["status"])
    elif run["conclusion"] != "success":
        print("fail " + name + " concluded " + str(run["conclusion"])); sys.exit()
for name in os.environ["STARTED"].split():
    run = latest.get(name)
    if run is None:
        waiting.append(f"{name} not started")
    elif run["status"] == "completed" and run["conclusion"] != "success":
        print("fail " + name + " concluded " + str(run["conclusion"])); sys.exit()
print("wait " + ", ".join(waiting) if waiting else "ok")
'
}

deadline=$((SECONDS + PUBLISH_TIMEOUT_S))
state="wait nothing checked yet"
while :; do
  state="$(publish_state || echo "wait the Actions API was not reachable")"
  case "$state" in
    ok) break ;;
    fail*)
      log "DEPLOY FAILED: publish (tag=refs/tags/${TAG} commit=${COMMIT}) — ${VERSION}: ${state#fail }"
      exit 1
      ;;
  esac
  if [ "$SECONDS" -ge "$deadline" ]; then
    log "DEPLOY FAILED: publish (tag=refs/tags/${TAG} commit=${COMMIT}) — ${VERSION} after ${PUBLISH_TIMEOUT_S}s: ${state#wait }"
    exit 1
  fi
  sleep "$POLL_S"
done

printf 'refs/tags/%s:%s\n' "$TAG" "$COMMIT" >"$LAST_GOOD_FILE"
log "DEPLOY OK tag=refs/tags/${TAG} commit=${COMMIT} version=${VERSION}"
