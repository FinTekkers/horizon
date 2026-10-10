#!/usr/bin/env bash
# Behavioral test harness for infra/host/deploy-shoreward.sh. git runs for real
# against a throwaway upstream with three release tags. npm, npx (vite), sudo,
# systemctl and curl are PATH stubs: the vite stub writes a fake dist from the
# checked-out commit, and the curl stub serves $REPO_DIR/dist as the "site", so
# the health check really reads what the swap left in place.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR="$(cd "$HERE/.." && pwd)"
WORK="$(mktemp -d)"
STUBS="$WORK/stubs"
mkdir -p "$STUBS"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }
not_ok() { fail=$((fail + 1)); echo "not ok - $1"; }
expect() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else not_ok "$name"; fi; }

# ---- stub commands ----

cat >"$STUBS/npm" <<'EOF'
#!/usr/bin/env bash
echo "npm $* $(git rev-parse HEAD)" >>"${CALL_LOG:?}"
EOF

# `npx vite build --outDir DIR --emptyOutDir`: writes index.html (titled from
# the repo's TITLE file, default "shoreward.ai") referencing one bundle, the
# bundle itself, and contact.html — unless the commit carries fail-build.
cat >"$STUBS/npx" <<'EOF'
#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--outDir" ]; then out="$2"; shift; fi
  shift
done
sha="$(git rev-parse HEAD)"
echo "build $sha" >>"${CALL_LOG:?}"
rm -rf "$out" && mkdir -p "$out/assets"
title="shoreward.ai"; [ -f TITLE ] && title="$(cat TITLE)"
printf '<html><head><title>%s</title><script src="/assets/main-%s.js"></script></head></html>\n' "$title" "${sha:0:8}" >"$out/index.html"
echo "built $sha" >"$out/assets/main-${sha:0:8}.js"
[ -e fail-build ] || echo contact >"$out/contact.html"
EOF

cat >"$STUBS/sudo" <<'EOF'
#!/usr/bin/env bash
exec "$@"
EOF

cat >"$STUBS/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >>"${CALL_LOG:?}"
[ "$1" = "is-active" ] && [ -n "${CONTACT_DOWN:-}" ] && exit 3
exit 0
EOF

# Serves $HORIZON_REPO_DIR/dist: the last argument is the URL. With -w it
# prints the status code; a missing file is curl -f's exit 22.
cat >"$STUBS/curl" <<'EOF'
#!/usr/bin/env bash
url="${!#}"
path="${url#*://*/}"
[ "$path" = "$url" ] && path=""
file="$HORIZON_REPO_DIR/dist/${path:-index.html}"
if [ ! -f "$file" ]; then exit 22; fi
case " $* " in
  *" -w "*) printf 200 ;;
  *) cat "$file" ;;
esac
EOF
chmod +x "$STUBS"/*

setup_repo() {
  # setup_repo BASE — tags: site-1 (good), site-2 (wrong title: health fails),
  # site-3 (build misses contact.html); a clone to deploy.
  local base="$1"
  git init --quiet --bare --initial-branch=main "$base/upstream.git"
  git clone --quiet "$base/upstream.git" "$base/seed" 2>/dev/null
  (
    cd "$base/seed" || exit 1
    git checkout --quiet -b main
    git config user.email test@example.com
    git config user.name "Deploy Test"
    printf 'dist/\ndist.new/\ndist.old/\nnode_modules/\n' >.gitignore
    echo one >api.js
    git add -A && git commit --quiet -m one && git tag site-1
    echo "Not found" >TITLE && git add -A && git commit --quiet -m two && git tag site-2
    git rm --quiet TITLE && touch fail-build && git add -A && git commit --quiet -m three && git tag site-3
    git push --quiet origin main --tags
  )
  git clone --quiet "$base/upstream.git" "$base/repo"
}

run_deploy() {
  # run_deploy BASE TAG [extra env assignments...]
  local base="$1" tag="$2"
  shift 2
  env PATH="$STUBS:$PATH" HOME="$base/home" \
    HORIZON_REPO_DIR="$base/repo" \
    HORIZON_STATE_DIR="$base/state" \
    HORIZON_HEALTH_URL="https://shoreward.test/" \
    HORIZON_HEALTH_TIMEOUT_S=1 HORIZON_HEALTH_POLL_S=0 \
    HORIZON_DEPLOY_LOCK_TIMEOUT_S=5 \
    CALL_LOG="$base/calls.log" \
    "$@" \
    "$HOST_DIR/deploy-shoreward.sh" "$tag" >/dev/null 2>&1
}

new_base() {
  local base
  base="$(mktemp -d "$WORK/run.XXXX")"
  mkdir -p "$base/home"
  setup_repo "$base"
  : >"$base/calls.log"
  echo "$base"
}

sha_of() { git -C "$1/seed" rev-parse "$2"; }
head_of() { git -C "$1/repo" rev-parse HEAD; }
served_sha() { grep -o 'built [0-9a-f]*' "$1"/repo/dist/assets/*.js | cut -d' ' -f2; }

# ---- 1. a good release is built, swapped in, the contact service restarted ----
base="$(new_base)"
run_deploy "$base" site-1
code=$?
sha1="$(sha_of "$base" site-1)"
expect "ok: exits 0" test "$code" -eq 0
expect "ok: HEAD is the release tag" test "$(head_of "$base")" = "$sha1"
expect "ok: dist serves the tag's build" test "$(served_sha "$base")" = "$sha1"
expect "ok: no dist.new or dist.old left behind" test ! -e "$base/repo/dist.new" -a ! -e "$base/repo/dist.old"
expect "ok: restarted shoreward-contact" grep -q "systemctl restart shoreward-contact" "$base/calls.log"
expect "ok: records last-good-tag" grep -qx "refs/tags/site-1:$sha1" "$base/state/last-good-tag"
expect "ok: DEPLOY OK is the last line" bash -c "tail -n1 '$base/state/self-deploy.log' | grep -q 'DEPLOY OK tag=refs/tags/site-1 commit=$sha1\$'"

# ---- 2. health check fails (wrong page): the previous build and code come back ----
: >"$base/calls.log"
run_deploy "$base" site-2
code=$?
expect "health fails: exits non-zero" test "$code" -ne 0
expect "health fails: dist is the previous build again" test "$(served_sha "$base")" = "$sha1"
expect "health fails: HEAD is back on the previous commit" test "$(head_of "$base")" = "$sha1"
expect "health fails: the contact service restarted twice (new, then rollback)" test "$(grep -c 'systemctl restart shoreward-contact' "$base/calls.log")" -eq 2
expect "health fails: logs the reason" grep -q "DEPLOY FAILED: health-check (tag=refs/tags/site-2.*no <title>shoreward" "$base/state/self-deploy.log"
expect "health fails: ROLLED BACK is the last line" bash -c "tail -n1 '$base/state/self-deploy.log' | grep -q 'ROLLED BACK to commit=$sha1'"
expect "health fails: last-good-tag unchanged" grep -qx "refs/tags/site-1:$sha1" "$base/state/last-good-tag"

# ---- 3. build is incomplete: nothing is swapped and nothing restarts ----
: >"$base/calls.log"
run_deploy "$base" site-3
code=$?
expect "bad build: exits non-zero" test "$code" -ne 0
expect "bad build: dist still serves the previous build" test "$(served_sha "$base")" = "$sha1"
expect "bad build: HEAD is back on the previous commit" test "$(head_of "$base")" = "$sha1"
expect "bad build: no restart" bash -c "! grep -q 'systemctl restart' '$base/calls.log'"
expect "bad build: no dist.new left behind" test ! -e "$base/repo/dist.new"
expect "bad build: logs DEPLOY FAILED: build" grep -q "DEPLOY FAILED: build (tag=refs/tags/site-3" "$base/state/self-deploy.log"

# ---- 4. the contact service doesn't come up: rolled back ----
base="$(new_base)"
run_deploy "$base" site-1
: >"$base/calls.log"
git -C "$base/seed" tag site-1b site-1
git -C "$base/seed" push --quiet origin site-1b
run_deploy "$base" site-1b CONTACT_DOWN=1
code=$?
expect "contact down: exits non-zero" test "$code" -ne 0
expect "contact down: logs the reason" grep -q "shoreward-contact is not active" "$base/state/self-deploy.log"

echo "# deploy-shoreward: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
