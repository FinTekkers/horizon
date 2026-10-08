#!/usr/bin/env bash
# Behavioral test harness for infra/host/deploy-code-only.sh through its
# deploy-market-data-inputs.sh wrapper (HZ-353). git runs for real against a
# throwaway upstream whose scripts/checks/install.sh and test.sh are stubs
# that log what ran, at which commit and with which env. sudo and systemctl
# are PATH stubs that log any call, and the repo's loader logs if it runs:
# a code-only deploy must never call any of them.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR="$(cd "$HERE/.." && pwd)"
WORK="$(mktemp -d)"
STUBS="$WORK/stubs"
mkdir -p "$STUBS"
HOLDER_PID=""
trap '[ -n "$HOLDER_PID" ] && kill "$HOLDER_PID" 2>/dev/null; rm -rf "$WORK"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }
not_ok() { fail=$((fail + 1)); echo "not ok - $1"; }
expect() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else not_ok "$name"; fi; }

for cmd in sudo systemctl; do
  cat >"$STUBS/$cmd" <<EOF
#!/usr/bin/env bash
echo "$cmd \$*" >>"\${FORBIDDEN_LOG:?}"
exit 1
EOF
  chmod +x "$STUBS/$cmd"
done

setup_repo() {
  # setup_repo BASE — upstream with three release tags: deploy-mdi-1 (good),
  # deploy-mdi-2 (install fails), deploy-mdi-3 (tests fail); a clone to deploy.
  local base="$1"
  git init --quiet --bare --initial-branch=main "$base/upstream.git"
  git clone --quiet "$base/upstream.git" "$base/seed" 2>/dev/null
  (
    cd "$base/seed" || exit 1
    git checkout --quiet -b main
    git config user.email test@example.com
    git config user.name "Deploy Test"
    mkdir -p scripts/checks
    echo .venv/ >.gitignore
    cat >scripts/checks/install.sh <<'EOF'
#!/usr/bin/env bash
echo "install $(git rev-parse HEAD)" >>"$CHECK_LOG"
env | grep -E '^(LEDGER|PRICE|VALUATION)_' >>"$ENV_LOG"
if [ -n "${INSTALL_FAIL_ALWAYS:-}" ] || [ -e fail-install ]; then exit 1; fi
mkdir -p .venv && git rev-parse HEAD >.venv/installed-for
EOF
    cat >scripts/checks/test.sh <<'EOF'
#!/usr/bin/env bash
echo "test $(git rev-parse HEAD)" >>"$CHECK_LOG"
env | grep -E '^(LEDGER|PRICE|VALUATION)_' >>"$ENV_LOG"
[ ! -e fail-test ]
EOF
    cat >scripts/load-prices.sh <<'EOF'
#!/usr/bin/env bash
echo "loader ran" >>"$FORBIDDEN_LOG"
EOF
    chmod +x scripts/checks/*.sh scripts/load-prices.sh
    git add -A && git commit --quiet -m one && git tag deploy-mdi-1
    touch fail-install && git add -A && git commit --quiet -m two && git tag deploy-mdi-2
    git rm --quiet fail-install && touch fail-test && git add -A && git commit --quiet -m three && git tag deploy-mdi-3
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
    HORIZON_DEPLOY_LOCK_TIMEOUT_S=5 \
    LEDGER_SERVICE_HOST=ledger.invalid PRICE_SERVICE_HOST=price.invalid \
    CHECK_LOG="$base/checks.log" ENV_LOG="$base/env.log" FORBIDDEN_LOG="$base/forbidden.log" \
    "$@" \
    "$HOST_DIR/deploy-market-data-inputs.sh" "$tag" >/dev/null 2>&1
}

new_base() {
  local base
  base="$(mktemp -d "$WORK/run.XXXX")"
  mkdir -p "$base/home"
  setup_repo "$base"
  : >"$base/checks.log"
  : >"$base/env.log"
  : >"$base/forbidden.log"
  echo "$base"
}

sha_of() { git -C "$1/seed" rev-parse "$2"; }
head_of() { git -C "$1/repo" rev-parse HEAD; }
last_line() { tail -n1 "$1/state/self-deploy.log"; }

# ---- 1. the tag is checked out, installed and tested; DEPLOY OK ----
{
  base="$(new_base)"
  run_deploy "$base" deploy-mdi-1
  code=$?
  sha1="$(sha_of "$base" deploy-mdi-1)"
  expect "ok: exits 0" test "$code" -eq 0
  expect "ok: HEAD is the release tag" test "$(head_of "$base")" = "$sha1"
  expect "ok: install then test ran at the tag" test "$(cat "$base/checks.log")" = "$(printf 'install %s\ntest %s' "$sha1" "$sha1")"
  expect "ok: the venv was installed for the tag" test "$(cat "$base/repo/.venv/installed-for")" = "$sha1"
  expect "ok: records last-good-tag" grep -qx "refs/tags/deploy-mdi-1:$sha1" "$base/state/last-good-tag"
  expect "ok: DEPLOY OK is the last line" bash -c "tail -n1 '$base/state/self-deploy.log' | grep -q 'DEPLOY OK tag=refs/tags/deploy-mdi-1 commit=$sha1\$'"
  expect "guardrail: install and tests never see ledger or price env" test ! -s "$base/env.log"
  expect "guardrail: no sudo, no systemctl, no loader" test ! -s "$base/forbidden.log"

  # ---- 2. tests fail: the last good code is put back ----
  : >"$base/checks.log"
  run_deploy "$base" deploy-mdi-3
  code=$?
  sha3="$(sha_of "$base" deploy-mdi-3)"
  expect "test fails: exits non-zero" test "$code" -ne 0
  expect "test fails: HEAD is back on the last good commit" test "$(head_of "$base")" = "$sha1"
  expect "test fails: the venv is reinstalled for the last good commit" test "$(cat "$base/repo/.venv/installed-for")" = "$sha1"
  expect "test fails: install, test, then the restore install" test "$(cat "$base/checks.log")" = "$(printf 'install %s\ntest %s\ninstall %s' "$sha3" "$sha3" "$sha1")"
  expect "test fails: last-good-tag unchanged" grep -qx "refs/tags/deploy-mdi-1:$sha1" "$base/state/last-good-tag"
  expect "test fails: logs RESTORE OK" grep -q "RESTORE OK tag=refs/tags/deploy-mdi-1 after refs/tags/deploy-mdi-3" "$base/state/self-deploy.log"
  expect "test fails: DEPLOY FAILED: test is the last line" bash -c "tail -n1 '$base/state/self-deploy.log' | grep -q 'DEPLOY FAILED: test (tag=refs/tags/deploy-mdi-3 commit=$sha3)'"
  expect "test fails: no DEPLOY OK for the tag" bash -c "! grep -q 'DEPLOY OK tag=refs/tags/deploy-mdi-3' '$base/state/self-deploy.log'"

  # ---- 3. install fails: tests never run, the last good code is put back ----
  : >"$base/checks.log"
  run_deploy "$base" deploy-mdi-2
  code=$?
  sha2="$(sha_of "$base" deploy-mdi-2)"
  expect "install fails: exits non-zero" test "$code" -ne 0
  expect "install fails: HEAD is back on the last good commit" test "$(head_of "$base")" = "$sha1"
  expect "install fails: test.sh never ran" bash -c "! grep -q '^test ' '$base/checks.log'"
  expect "install fails: the restore reinstalled the last good commit" test "$(cat "$base/checks.log")" = "$(printf 'install %s\ninstall %s' "$sha2" "$sha1")"
  expect "install fails: last-good-tag unchanged" grep -qx "refs/tags/deploy-mdi-1:$sha1" "$base/state/last-good-tag"
  expect "install fails: DEPLOY FAILED: install is the last line" bash -c "tail -n1 '$base/state/self-deploy.log' | grep -q 'DEPLOY FAILED: install (tag=refs/tags/deploy-mdi-2 commit=$sha2)'"
  expect "guardrail: still no sudo, systemctl or loader after failures" test ! -s "$base/forbidden.log"
  expect "guardrail: still no ledger or price env after failures" test ! -s "$base/env.log"

  # ---- 4. the restore's install fails too ----
  run_deploy "$base" deploy-mdi-2 INSTALL_FAIL_ALWAYS=1
  code=$?
  expect "restore fails: exits non-zero" test "$code" -ne 0
  expect "restore fails: RESTORE FAILED (install) is logged" grep -q "RESTORE FAILED (install) tag=refs/tags/deploy-mdi-1 after refs/tags/deploy-mdi-2" "$base/state/self-deploy.log"
  expect "restore fails: RESTORE FAILED comes right before the final DEPLOY FAILED" bash -c \
    "tail -n2 '$base/state/self-deploy.log' | head -n1 | grep -q 'RESTORE FAILED (install)' && tail -n1 '$base/state/self-deploy.log' | grep -q 'DEPLOY FAILED: install (tag=refs/tags/deploy-mdi-2'"
  expect "restore fails: last-good-tag unchanged" grep -qx "refs/tags/deploy-mdi-1:$sha1" "$base/state/last-good-tag"
}

# ---- 5. another deploy holds the lock: nothing moves ----
{
  base="$(new_base)"
  run_deploy "$base" deploy-mdi-1
  sha1="$(sha_of "$base" deploy-mdi-1)"
  : >"$base/checks.log"
  (
    exec 9>"$base/state/deploy.lock"
    flock 9
    touch "$base/held"
    exec sleep 60
  ) &
  HOLDER_PID=$!
  for _ in $(seq 1 100); do [ -e "$base/held" ] && break; sleep 0.05; done
  expect "lock: the holder has the lock" test -e "$base/held"
  run_deploy "$base" deploy-mdi-3 HORIZON_DEPLOY_LOCK_TIMEOUT_S=1
  code=$?
  kill "$HOLDER_PID" 2>/dev/null
  wait "$HOLDER_PID" 2>/dev/null
  HOLDER_PID=""
  expect "lock: exits non-zero" test "$code" -ne 0
  expect "lock: DEPLOY FAILED: lock is the last line" bash -c "tail -n1 '$base/state/self-deploy.log' | grep -q 'DEPLOY FAILED: lock (tag=deploy-mdi-3)'"
  expect "lock: HEAD did not move" test "$(head_of "$base")" = "$sha1"
  expect "lock: install and tests never ran" test ! -s "$base/checks.log"
  expect "lock: last-good-tag unchanged" grep -qx "refs/tags/deploy-mdi-1:$sha1" "$base/state/last-good-tag"
}

# ---- 6. a failure with no last-good-tag skips the restore ----
{
  base="$(new_base)"
  run_deploy "$base" deploy-mdi-3
  code=$?
  expect "no last-good: exits non-zero" test "$code" -ne 0
  expect "no last-good: logs RESTORE SKIPPED" grep -q "RESTORE SKIPPED: no last-good-tag (after refs/tags/deploy-mdi-3)" "$base/state/self-deploy.log"
  expect "no last-good: DEPLOY FAILED: test is the last line" bash -c "tail -n1 '$base/state/self-deploy.log' | grep -q 'DEPLOY FAILED: test (tag=refs/tags/deploy-mdi-3'"
  expect "no last-good: writes no last-good-tag" test ! -e "$base/state/last-good-tag"
}

# ---- 7. an unknown release tag installs nothing ----
{
  base="$(new_base)"
  before="$(head_of "$base")"
  run_deploy "$base" no-such-tag
  code=$?
  expect "unknown tag: exits non-zero" test "$code" -ne 0
  expect "unknown tag: logs DEPLOY FAILED: resolve" grep -q "DEPLOY FAILED: resolve (tag=no-such-tag)" "$base/state/self-deploy.log"
  expect "unknown tag: HEAD did not move" test "$(head_of "$base")" = "$before"
  expect "unknown tag: install and tests never ran" test ! -s "$base/checks.log"
}

echo "# deploy-code-only: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
