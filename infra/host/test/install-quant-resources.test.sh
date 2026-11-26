#!/usr/bin/env bash
# HZ-972: behavioral test for infra/host/install-quant-resources.sh. git runs
# for real against a throwaway bare repo standing in for FinTekkers/quant-library,
# whose sync.sh is a stub that logs each run and builds libs/ and venv/ (both
# git-ignored, as in the real repo) only when they are missing. The registry is
# a temp copy whose store.sha the test moves.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/install-quant-resources.sh"
WORK="$(mktemp -d)"
# The script leaves read-only dirs behind; unlock them so the cleanup works.
trap 'chmod -R u+w "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }
not_ok() { fail=$((fail + 1)); echo "not ok - $1"; }
expect() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else not_ok "$name"; fi; }

g() { git -c user.name=t -c user.email=t@example.com "$@"; }

UPSTREAM="$WORK/upstream.git"
SEED="$WORK/seed"
STORE="$WORK/store"
REGISTRY="$WORK/quant_resources.json"
export SYNC_LOG="$WORK/sync.log"

g init --quiet --bare --initial-branch=main "$UPSTREAM"
g clone --quiet "$UPSTREAM" "$SEED" 2>/dev/null
cat >"$SEED/sync.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "sync $(git rev-parse HEAD)" >>"$SYNC_LOG"
mkdir -p libs/lib_a venv/bin
[ -f libs/lib_a/source.h ] || echo "int x;" >libs/lib_a/source.h
[ -f venv/bin/python ] || { printf '#!/bin/sh\n' >venv/bin/python; chmod +x venv/bin/python; }
EOF
chmod +x "$SEED/sync.sh"
printf 'libs/\nvenv/\n' >"$SEED/.gitignore"
echo "# quant-library" >"$SEED/README.md"
g -C "$SEED" add -A && g -C "$SEED" commit --quiet -m first && g -C "$SEED" push --quiet origin HEAD:main
FIRST="$(g -C "$SEED" rev-parse HEAD)"

pin() { printf '{"version": 1, "store": {"repo": "FinTekkers/quant-library", "path": "%s", "sha": "%s"}}\n' "$STORE" "$1" >"$REGISTRY"; }

run() {
  HORIZON_QUANT_RESOURCES_DIR="$STORE" QUANT_LIBRARY_URL="file://$UPSTREAM" QUANT_RESOURCES_REGISTRY="$REGISTRY" \
    bash "$SCRIPT" >"$WORK/out.log" 2>&1
}

state() {
  # HEAD, the worktree status, the commit count and every mode under the store.
  git -C "$STORE" rev-parse HEAD
  git -C "$STORE" status --porcelain
  git -C "$STORE" rev-list --count --all
  (cd "$STORE" && find . -path ./.git -prune -o -printf '%m %p\n' | sort)
}

# ---- first run: clone, check out the pin, sync, lock down ----
mkdir "$STORE"  # root creates it once; the script clones into it
pin "$FIRST"
expect "the first run succeeds" run
expect "it cloned the repo" grep -q "cloning" "$WORK/out.log"
expect "it checked out the pinned commit" test "$(git -C "$STORE" rev-parse HEAD)" = "$FIRST"
expect "it ran sync.sh once" test "$(wc -l <"$SYNC_LOG")" -eq 1
expect "sync.sh built libs/ and venv/" test -f "$STORE/libs/lib_a/source.h" -a -f "$STORE/venv/bin/python"
expect "libs/ and venv/ have no write bit" test -z "$(find "$STORE/libs" "$STORE/venv" -perm /222)"
expect "libs/ and venv/ have no world bit" test -z "$(find "$STORE/libs" "$STORE/venv" -perm /007)"
expect "the store itself is closed to other users" test "$(( 0$(stat -c %a "$STORE") & 07 ))" -eq 0
expect "libs/ mode has no world read (stat %a ends in 0)" test "$(stat -c %a "$STORE/libs" | tail -c 2)" = "0"
expect "the farm user can still read the library source" test -r "$STORE/libs/lib_a/source.h"
expect "the farm user can still run the venv" test -x "$STORE/venv/bin/python"

# ---- second run: nothing changes ----
before="$(state)"
expect "the second run succeeds" run
expect "it did not clone again" bash -c "! grep -q cloning '$WORK/out.log'"
expect "it did not check out again" bash -c "! grep -q 'checking out' '$WORK/out.log'"
expect "it still called sync.sh" test "$(wc -l <"$SYNC_LOG")" -eq 2
expect "HEAD, git status, commits and every file mode are unchanged" test "$before" = "$(state)"
expect "git status is clean" test -z "$(git -C "$STORE" status --porcelain)"

# ---- a new pin: fetch and move to it ----
echo "more" >>"$SEED/README.md"
g -C "$SEED" commit --quiet -am second && g -C "$SEED" push --quiet origin HEAD:main
SECOND="$(g -C "$SEED" rev-parse HEAD)"
pin "$SECOND"
expect "a run after the pin moved succeeds" run
expect "it moved the checkout to the new pin" test "$(git -C "$STORE" rev-parse HEAD)" = "$SECOND"
expect "sync.sh ran at the new pin" test "$(tail -n 1 "$SYNC_LOG")" = "sync $SECOND"
expect "libs/ and venv/ are read-only again" test -z "$(find "$STORE/libs" "$STORE/venv" -perm /222)"

# ---- refusals ----
printf '{"store": {"sha": "main"}}\n' >"$REGISTRY"
expect "a pin that is not a 40-hex commit is refused" bash -c "! HORIZON_QUANT_RESOURCES_DIR='$STORE' QUANT_LIBRARY_URL='file://$UPSTREAM' QUANT_RESOURCES_REGISTRY='$REGISTRY' bash '$SCRIPT'"
expect "and the checkout stays where it was" test "$(git -C "$STORE" rev-parse HEAD)" = "$SECOND"

echo "# pass $pass fail $fail"
[ "$fail" -eq 0 ]
