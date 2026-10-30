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

# HZ-442: stands in for a target's own build command (HORIZON_BUILD_COMMAND).
# Logs like install.sh and fails the same way: at a commit with fail-install
# (deploy-mdi-2), or everywhere with OVERRIDE_FAIL_ALWAYS=1. OVERRIDE_LOG
# gets "<physical cwd> <args>".
cat >"$STUBS/repo-build" <<'EOF'
#!/usr/bin/env bash
echo "build $(git rev-parse HEAD)" >>"$CHECK_LOG"
printf '%s %s\n' "$(pwd -P)" "$*" >>"$OVERRIDE_LOG"
env | grep -E '^(LEDGER|PRICE|VALUATION)_' >>"$ENV_LOG"
if [ -n "${OVERRIDE_FAIL_ALWAYS:-}" ] || [ -e fail-install ]; then exit 1; fi
EOF
chmod +x "$STUBS/repo-build"

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
    # HZ-666: both also print to stdout (and test.sh to stderr) what the
    # deploy should capture: a known line, the filtered env (never the full
    # env, which can hold host secrets), then CHECK_OUTPUT_LINES numbered lines.
    cat >scripts/checks/install.sh <<'EOF'
#!/usr/bin/env bash
echo "install $(git rev-parse HEAD)" >>"$CHECK_LOG"
env | grep -E '^(LEDGER|PRICE|VALUATION)_' >>"$ENV_LOG"
echo "install output at $(git rev-parse HEAD)"
env | grep -E '^(LEDGER|PRICE|VALUATION|KEEP_ME)_'
for i in $(seq 1 "${CHECK_OUTPUT_LINES:-0}"); do echo "out-line $i"; done
if [ -n "${INSTALL_FAIL_ALWAYS:-}" ] || [ -e fail-install ]; then exit 1; fi
mkdir -p .venv && git rev-parse HEAD >.venv/installed-for
EOF
    cat >scripts/checks/test.sh <<'EOF'
#!/usr/bin/env bash
echo "test $(git rev-parse HEAD)" >>"$CHECK_LOG"
env | grep -E '^(LEDGER|PRICE|VALUATION)_' >>"$ENV_LOG"
echo "test output at $(git rev-parse HEAD)"
echo "test stderr at $(git rev-parse HEAD)" >&2
env | grep -E '^(LEDGER|PRICE|VALUATION|KEEP_ME)_'
for i in $(seq 1 "${CHECK_OUTPUT_LINES:-0}"); do echo "out-line $i"; done
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
  # -u: a stray HORIZON_BUILD_COMMAND here would replace install.sh.
  env -u HORIZON_BUILD_COMMAND PATH="$STUBS:$PATH" HOME="$base/home" \
    HORIZON_REPO_DIR="$base/repo" \
    HORIZON_STATE_DIR="$base/state" \
    HORIZON_DEPLOY_LOCK_TIMEOUT_S=5 \
    LEDGER_SERVICE_HOST=ledger.invalid PRICE_SERVICE_HOST=price.invalid \
    KEEP_ME_HOST=kept.invalid \
    CHECK_LOG="$base/checks.log" ENV_LOG="$base/env.log" FORBIDDEN_LOG="$base/forbidden.log" \
    OVERRIDE_LOG="$base/override.log" \
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
# block_of BASE STAGE TAG — the lines between the --- STAGE output markers
# for TAG in self-deploy.log (HZ-666), markers excluded.
block_of() {
  awk -v start="--- $2 output (tag=refs/tags/$3) ---" -v end="--- end $2 output (tag=refs/tags/$3) ---" \
    '$0 == end { on = 0 } on { print } $0 == start { on = 1 }' "$1/state/self-deploy.log"
}
# line_of BASE PATTERN — the number of the first log line matching PATTERN.
line_of() { grep -n -m1 -F -- "$2" "$1/state/self-deploy.log" | cut -d: -f1; }

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
  expect "ok: logs the default build line" grep -qE "^[^ ]+ build: scripts/checks/install.sh$" "$base/state/self-deploy.log"
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
  # HZ-666: the failing test output is in the log, ahead of the restore.
  block="$(block_of "$base" test deploy-mdi-3)"
  expect "test output: the known stdout line is in the test output block" grep -qx "test output at $sha3" <<<"$block"
  expect "test output: the stderr line is in the block too" grep -qx "test stderr at $sha3" <<<"$block"
  expect "test output: block, then RESTORE OK, then DEPLOY FAILED last" test \
    "$(line_of "$base" "--- test output (tag=refs/tags/deploy-mdi-3) ---")" -lt "$(line_of "$base" "RESTORE OK tag=refs/tags/deploy-mdi-1 after refs/tags/deploy-mdi-3")"
  expect "test output: RESTORE OK comes right before the final DEPLOY FAILED" bash -c \
    "tail -n2 '$base/state/self-deploy.log' | head -n1 | grep -q 'RESTORE OK tag=refs/tags/deploy-mdi-1 after refs/tags/deploy-mdi-3'"
  expect "test output: the block holds nothing from the restore install" bash -c "! grep -q '$sha1' <<<\"\$1\"" _ "$block"
  expect "test output: the restore did not overwrite the test output file" grep -qx "test output at $sha3" "$base/state/deploy-deploy-mdi-3-test.out"
  expect "test output: the test output file holds nothing from the restore" bash -c "! grep -q '$sha1' '$base/state/deploy-deploy-mdi-3-test.out'"
  expect "test output: the restore install has its own file" grep -qx "install output at $sha1" "$base/state/deploy-deploy-mdi-3-restore-install.out"

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
  # HZ-666: the failing install output is in the log; the restore's install,
  # the same stage, neither overwrites its file nor adds a second block.
  block="$(block_of "$base" install deploy-mdi-2)"
  expect "install output: the known line is in the install output block" grep -qx "install output at $sha2" <<<"$block"
  expect "install output: the block comes before the final DEPLOY FAILED: install" test \
    "$(line_of "$base" "--- end install output (tag=refs/tags/deploy-mdi-2) ---")" -lt "$(wc -l <"$base/state/self-deploy.log")"
  expect "install output: exactly one install output block for the tag" test \
    "$(grep -cxF -- "--- install output (tag=refs/tags/deploy-mdi-2) ---" "$base/state/self-deploy.log")" -eq 1
  expect "install output: the block holds nothing from the restore install" bash -c "! grep -q '$sha1' <<<\"\$1\"" _ "$block"
  expect "install output: the install output file still holds the failing install" grep -qx "install output at $sha2" "$base/state/deploy-deploy-mdi-2-install.out"
  expect "install output: the install output file holds nothing from the restore" bash -c "! grep -q '$sha1' '$base/state/deploy-deploy-mdi-2-install.out'"
  expect "install output: the restore install has its own file" grep -qx "install output at $sha1" "$base/state/deploy-deploy-mdi-2-restore-install.out"

  # ---- 4. the restore's install fails too ----
  run_deploy "$base" deploy-mdi-2 INSTALL_FAIL_ALWAYS=1
  code=$?
  expect "restore fails: exits non-zero" test "$code" -ne 0
  expect "restore fails: RESTORE FAILED (install) is logged" grep -q "RESTORE FAILED (install) tag=refs/tags/deploy-mdi-1 after refs/tags/deploy-mdi-2" "$base/state/self-deploy.log"
  expect "restore fails: RESTORE FAILED comes right before the final DEPLOY FAILED" bash -c \
    "tail -n2 '$base/state/self-deploy.log' | head -n1 | grep -q 'RESTORE FAILED (install)' && tail -n1 '$base/state/self-deploy.log' | grep -q 'DEPLOY FAILED: install (tag=refs/tags/deploy-mdi-2'"
  expect "restore fails: last-good-tag unchanged" grep -qx "refs/tags/deploy-mdi-1:$sha1" "$base/state/last-good-tag"
  expect "restore fails: a redeploy of the tag starts its output file afresh" test \
    "$(grep -c '^# stage=' "$base/state/deploy-deploy-mdi-2-install.out")" -eq 1
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

# ---- 8. HZ-442: the target's build command replaces install.sh ----
{
  base="$(new_base)"
  run_deploy "$base" deploy-mdi-1 HORIZON_BUILD_COMMAND='repo-build --local'
  code=$?
  sha1="$(sha_of "$base" deploy-mdi-1)"
  expect "build command: exits 0" test "$code" -eq 0
  expect "build command: it ran instead of install.sh, then test.sh" test "$(cat "$base/checks.log")" = "$(printf 'build %s\ntest %s' "$sha1" "$sha1")"
  expect "build command: ran in the checkout" test "$(cat "$base/override.log")" = "$(cd "$base/repo" && pwd -P) --local"
  expect "build command: logs build: <command>" grep -qE "^[^ ]+ build: repo-build --local$" "$base/state/self-deploy.log"
  expect "build command: DEPLOY OK is the last line" bash -c "tail -n1 '$base/state/self-deploy.log' | grep -q 'DEPLOY OK tag=refs/tags/deploy-mdi-1 commit=$sha1\$'"
  expect "build command: still never sees ledger or price env" test ! -s "$base/env.log"

  # It fails only at deploy-mdi-2, so the restore at deploy-mdi-1 passes.
  : >"$base/checks.log"
  run_deploy "$base" deploy-mdi-2 HORIZON_BUILD_COMMAND='repo-build --local'
  code=$?
  sha2="$(sha_of "$base" deploy-mdi-2)"
  log="$base/state/self-deploy.log"
  expect "build command fails: exits non-zero" test "$code" -ne 0
  expect "build command fails: the restore ran it at the last good commit" test "$(cat "$base/checks.log")" = "$(printf 'build %s\nbuild %s' "$sha2" "$sha1")"
  expect "build command fails: HEAD is back on the last good commit" test "$(head_of "$base")" = "$sha1"
  expect "build command fails: RESTORE OK, then DEPLOY FAILED: install last" bash -c \
    "tail -n2 '$log' | head -n1 | grep -q 'RESTORE OK tag=refs/tags/deploy-mdi-1 after refs/tags/deploy-mdi-2' && tail -n1 '$log' | grep -q 'DEPLOY FAILED: install (tag=refs/tags/deploy-mdi-2 commit=$sha2)'"
  expect "build command fails: last-good-tag unchanged" grep -qx "refs/tags/deploy-mdi-1:$sha1" "$base/state/last-good-tag"

  # It fails everywhere, so the restore fails too.
  run_deploy "$base" deploy-mdi-2 HORIZON_BUILD_COMMAND='repo-build --local' OVERRIDE_FAIL_ALWAYS=1
  code=$?
  expect "build command restore fails: exits non-zero" test "$code" -ne 0
  expect "build command restore fails: RESTORE FAILED (install), then DEPLOY FAILED: install last" bash -c \
    "tail -n2 '$log' | head -n1 | grep -q 'RESTORE FAILED (install) tag=refs/tags/deploy-mdi-1 after refs/tags/deploy-mdi-2' && tail -n1 '$log' | grep -q 'DEPLOY FAILED: install (tag=refs/tags/deploy-mdi-2'"
  expect "build command restore fails: last-good-tag unchanged" grep -qx "refs/tags/deploy-mdi-1:$sha1" "$base/state/last-good-tag"
}
# Set but empty is the same as unset: install.sh.
{
  base="$(new_base)"
  run_deploy "$base" deploy-mdi-1 HORIZON_BUILD_COMMAND=
  code=$?
  sha1="$(sha_of "$base" deploy-mdi-1)"
  expect "empty build command: exits 0" test "$code" -eq 0
  expect "empty build command: install then test ran" test "$(cat "$base/checks.log")" = "$(printf 'install %s\ntest %s' "$sha1" "$sha1")"
  expect "empty build command: logs the default build line" grep -qE "^[^ ]+ build: scripts/checks/install.sh$" "$base/state/self-deploy.log"
}

# ---- 9. HZ-666: the log keeps only the last 200 lines of the failing output ----
{
  base="$(new_base)"
  run_deploy "$base" deploy-mdi-3 CHECK_OUTPUT_LINES=250
  block="$(block_of "$base" test deploy-mdi-3)"
  expect "200 lines: the block holds exactly 200 lines" test "$(grep -c '' <<<"$block")" -eq 200
  expect "200 lines: the first is out-line 51" bash -c "head -n1 <<<\"\$1\" | grep -qx 'out-line 51'" _ "$block"
  expect "200 lines: the last is out-line 250" bash -c "tail -n1 <<<\"\$1\" | grep -qx 'out-line 250'" _ "$block"
  expect "200 lines: out-line 50 is not in the block" bash -c "! grep -qx 'out-line 50' <<<\"\$1\"" _ "$block"
  expect "200 lines: DEPLOY FAILED: test is still the last line" bash -c "tail -n1 '$base/state/self-deploy.log' | grep -q 'DEPLOY FAILED: test (tag=refs/tags/deploy-mdi-3'"
}

# ---- 10. HZ-666: a passing deploy logs no output block but keeps its file ----
{
  base="$(new_base)"
  run_deploy "$base" deploy-mdi-1
  code=$?
  sha1="$(sha_of "$base" deploy-mdi-1)"
  expect "pass output: exits 0" test "$code" -eq 0
  expect "pass output: no output block in the log" test "$(grep -c -- '^--- .* output' "$base/state/self-deploy.log")" -eq 0
  expect "pass output: the test output file holds the stage output" grep -qx "test output at $sha1" "$base/state/deploy-deploy-mdi-1-test.out"
  expect "pass output: the install output file holds the stage output" grep -qx "install output at $sha1" "$base/state/deploy-deploy-mdi-1-install.out"
}

# ---- 11. HZ-666: only the newest 20 output files are kept ----
{
  base="$(new_base)"
  mkdir -p "$base/state"
  for n in $(seq 1 22); do
    echo old >"$base/state/deploy-old-$n-test.out"
    touch -d "@$((1700000000 + n * 60))" "$base/state/deploy-old-$n-test.out"
  done
  run_deploy "$base" deploy-mdi-1
  expect "retention: 20 output files remain" test "$(find "$base/state" -maxdepth 1 -name 'deploy-*.out' | wc -l)" -eq 20
  for n in 1 2 3 4; do
    expect "retention: the old file $n is deleted" test ! -e "$base/state/deploy-old-$n-test.out"
  done
  kept=0
  for n in $(seq 5 22); do [ -e "$base/state/deploy-old-$n-test.out" ] && kept=$((kept + 1)); done
  expect "retention: the 18 newest old files survive" test "$kept" -eq 18
  expect "retention: the new install output file exists" test -e "$base/state/deploy-deploy-mdi-1-install.out"
  expect "retention: the new test output file exists" test -e "$base/state/deploy-deploy-mdi-1-test.out"
  expect "retention: the log and last-good-tag are left alone" test -e "$base/state/self-deploy.log" -a -e "$base/state/last-good-tag"
}

# ---- HZ-666: no output file holds a stripped variable's value ----
{
  outs=("$WORK"/run.*/state/deploy-*.out)
  expect "guardrail: output files were written" test -e "${outs[0]}"
  expect "guardrail: an unstripped variable reaches the output files" grep -qx 'KEEP_ME_HOST=kept.invalid' "${outs[@]}"
  expect "guardrail: no output file holds the ledger or price value" bash -c '! grep -qE "ledger\.invalid|price\.invalid" "$@"' _ "${outs[@]}"
}

echo "# deploy-code-only: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
