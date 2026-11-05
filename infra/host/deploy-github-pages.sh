#!/usr/bin/env bash
# Shared deploy for a repo published by GitHub Pages: nothing of the repo
# runs on this host. GitHub publishes the site itself when main moves, so
# this waits for that. Not a deploy target itself: each deploy-<repo>.sh
# wrapper sets the DEPLOY_* variables below and execs this with Horizon's
# release tag. Health check type deploy-log, like deploy-code-only.sh.
#
# It resolves the tag to a commit through GitHub's public API, waits until a
# successful github-pages deployment holds that commit (the same commit, or a
# later one on main), then fetches the site, writes $STATE_DIR/last-good-tag
# (what Horizon's deploy queue reads as live) and records DEPLOY OK in
# $STATE_DIR/self-deploy.log. Any failure logs DEPLOY FAILED: <stage> as the
# last line. No checkout, no install and no sudo. The repo is public, but
# GitHub allows only 60 unauthenticated API calls an hour per host, so when
# DEPLOY_PAGES_TOKEN_FILE is readable its token is sent as a header, read from
# a 0600 temp file: never in argv, a URL or the log.
#
#   DEPLOY_NAME        state dir name under ~/.horizon/
#   DEPLOY_PAGES_REPO  owner/name
#   DEPLOY_PAGES_URL   the published site, fetched once the deploy is live
#   DEPLOY_PAGES_TOKEN_FILE  optional: a file holding a token that can read the repo
set -euo pipefail
TAG="${1:-}"
: "${DEPLOY_NAME:?set by the deploy-<repo>.sh wrapper}"
: "${DEPLOY_PAGES_REPO:?set by the deploy-<repo>.sh wrapper}"
: "${DEPLOY_PAGES_URL:?set by the deploy-<repo>.sh wrapper}"
# Overridable for the test harness (infra/host/test/deploy-github-pages.test.sh).
API="${HORIZON_GITHUB_API:-https://api.github.com}"
STATE_DIR="${HORIZON_STATE_DIR:-$HOME/.horizon/$DEPLOY_NAME}"
WAIT_S="${HORIZON_PAGES_WAIT_S:-900}"
POLL_S="${HORIZON_PAGES_POLL_S:-15}"

mkdir -p "$STATE_DIR"
LOG_FILE="$STATE_DIR/self-deploy.log"
log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"$LOG_FILE"
}
STAGE="tag"
trap 'log "DEPLOY FAILED: ${STAGE} (tag=${TAG:-none})"' ERR

AUTH=()
if [ -n "${DEPLOY_PAGES_TOKEN_FILE:-}" ] && [ -r "$DEPLOY_PAGES_TOKEN_FILE" ]; then
  HEADER_FILE="$(mktemp)"
  chmod 600 "$HEADER_FILE"
  trap 'rm -f "$HEADER_FILE"' EXIT
  printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' <"$DEPLOY_PAGES_TOKEN_FILE")" >"$HEADER_FILE"
  AUTH=(-H "@$HEADER_FILE")
fi

get() {
  curl -fsSL --max-time 20 -H 'Accept: application/vnd.github+json' "${AUTH[@]}" "$API$1"
}
json() {
  python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"
}

log "DEPLOY START tag=${TAG:-none} repo=${DEPLOY_PAGES_REPO}"
[ -n "$TAG" ] || false
COMMIT="$(get "/repos/${DEPLOY_PAGES_REPO}/commits/${TAG}" | json "d['sha']")"
log "tag ${TAG} is commit ${COMMIT}"

# The newest successful github-pages deployment's commit, or nothing.
live_commit() {
  local ids id state
  ids="$(get "/repos/${DEPLOY_PAGES_REPO}/deployments?environment=github-pages&per_page=10" | json "' '.join(str(x['id'])+':'+x['sha'] for x in d)")"
  for id in $ids; do
    state="$(get "/repos/${DEPLOY_PAGES_REPO}/deployments/${id%%:*}/statuses?per_page=1" | json "d[0]['state'] if d else ''")"
    if [ "$state" = success ]; then
      echo "${id#*:}"
      return
    fi
  done
}

# True when the live commit is the tag's commit or comes after it on main.
holds_tag() {
  [ "$1" = "$COMMIT" ] && return 0
  local status
  status="$(get "/repos/${DEPLOY_PAGES_REPO}/compare/${COMMIT}...$1" | json "d['status']")"
  [ "$status" = ahead ] || [ "$status" = identical ]
}

STAGE="pages"
deadline=$(( $(date +%s) + WAIT_S ))
while :; do
  live="$(live_commit || true)"
  if [ -n "$live" ] && holds_tag "$live"; then
    log "pages live at ${live}"
    break
  fi
  [ "$(date +%s)" -lt "$deadline" ] || false
  sleep "$POLL_S"
done

STAGE="site"
curl -fsS --max-time 20 -o /dev/null "$DEPLOY_PAGES_URL"
log "site ok ${DEPLOY_PAGES_URL}"
printf '%s:%s\n' "refs/tags/${TAG}" "$COMMIT" >"$STATE_DIR/last-good-tag"
log "DEPLOY OK tag=refs/tags/${TAG} commit=${COMMIT}"
