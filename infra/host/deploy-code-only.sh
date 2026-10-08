#!/usr/bin/env bash
# Shared self-deploy for code-only repos (HZ-353): code that runs on this host
# but has no service, such as Python loaders. Not a deploy target itself: each
# deploy-<repo>.sh wrapper sets the DEPLOY_* variables below and execs this
# with Horizon's release tag. Health check type deploy-log.
#
# Under the deploy lock: fetch, check out the tag (detached), run the repo's
# scripts/checks/install.sh (which updates its virtualenv) and then
# scripts/checks/test.sh in the checkout, then record last-good-tag and
# DEPLOY OK in $STATE_DIR/self-deploy.log. Same log contract as the other
# deploy scripts. Nothing restarts and no sudo is involved; no loader runs.
#
# Restore: when install or the tests fail, the script checks out the
# last-good-tag commit again and reruns install.sh there, so the venv matches
# that code. It logs RESTORE OK, RESTORE FAILED (<stage>) or, with no
# last-good-tag, RESTORE SKIPPED, and then DEPLOY FAILED: <install|test> as
# the last line. last-good-tag is never moved to the failed tag.
#
#   DEPLOY_NAME       state dir name under ~/.horizon/
#   DEPLOY_REPO_DIR   the checkout the code runs from
#   DEPLOY_STRIP_ENV  variables unset for install.sh and test.sh (space separated)
set -euo pipefail

TAG="${1:-}"

: "${DEPLOY_NAME:?set by the deploy-<repo>.sh wrapper}"
: "${DEPLOY_REPO_DIR:?set by the deploy-<repo>.sh wrapper}"

# Overridable for the test harness (infra/host/test/deploy-code-only.test.sh).
REPO_DIR="${HORIZON_REPO_DIR:-$DEPLOY_REPO_DIR}"
STATE_DIR="${HORIZON_STATE_DIR:-$HOME/.horizon/$DEPLOY_NAME}"
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

# No fallback to main: installing code no item was verified against would
# make a failed resolve look like a deploy.
STAGE="resolve"
if [ -z "$TAG" ] || ! COMMIT="$(git rev-parse -q --verify "refs/tags/$TAG^{commit}")"; then
  log "DEPLOY FAILED: resolve (tag=${TAG:-none}) — no such release tag"
  exit 1
fi
REF="refs/tags/$TAG"

STAGE="checkout"
git checkout --quiet --detach "$COMMIT"

# run_check NAME — runs scripts/checks/NAME.sh in the checkout with the
# DEPLOY_STRIP_ENV variables unset. Call it only from an if test, so a
# failure does not fire the ERR trap.
run_check() {
  local unset_args=() name
  for name in ${DEPLOY_STRIP_ENV:-}; do unset_args+=(-u "$name"); done
  env "${unset_args[@]}" bash "scripts/checks/$1.sh"
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

# fail_and_restore STAGE — puts the last good commit back (checkout, then
# install.sh, once), logs how that went, then logs DEPLOY FAILED: STAGE as the
# last line and exits 1. Never writes last-good-tag.
fail_and_restore() {
  local failed="$1" restore_msg
  if ! read_last_good; then
    restore_msg="RESTORE SKIPPED: no last-good-tag (after ${REF})"
  elif ! git cat-file -e "${LAST_GOOD_COMMIT}^{commit}" 2>/dev/null \
      || ! git checkout --quiet --detach "$LAST_GOOD_COMMIT"; then
    restore_msg="RESTORE FAILED (checkout) tag=${LAST_GOOD_REF} after ${REF}"
  elif ! run_check install; then
    restore_msg="RESTORE FAILED (install) tag=${LAST_GOOD_REF} after ${REF}"
  else
    restore_msg="RESTORE OK tag=${LAST_GOOD_REF} after ${REF}"
  fi
  log "$restore_msg"
  echo "$restore_msg" >&2
  log "DEPLOY FAILED: ${failed} (tag=${REF} commit=${COMMIT})"
  exit 1
}

STAGE="install"
if ! run_check install; then
  fail_and_restore install
fi

STAGE="test"
if ! run_check test; then
  fail_and_restore test
fi

printf '%s:%s\n' "$REF" "$COMMIT" >"$LAST_GOOD_FILE"
log "DEPLOY OK tag=${REF} commit=${COMMIT}"
