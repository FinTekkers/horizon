#!/usr/bin/env bash
# Behavioral test harness for infra/host/deploy.sh (HZ-19). Nothing in the
# repo's JS test runner can exercise a real shell script against a real
# systemd unit, so this stubs the external commands (npm, systemctl, sudo,
# curl) on PATH and points deploy.sh at a throwaway git repo instead of
# /opt/horizon. git itself is NOT stubbed — deploy.sh's fetch/checkout runs
# for real against the throwaway repo, which is exactly the logic worth
# proving.
#
# Wired into the root `npm test` (package.json) so these guardrails —
# idempotent, lock-serialized, a failed health-check exits non-zero and logs
# it — are enforced automatically instead of only by manual review.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SH="$HERE/../deploy.sh"
WORK="$(mktemp -d)"
STUBS="$WORK/stubs"
mkdir -p "$STUBS"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }
not_ok() { fail=$((fail + 1)); echo "not ok - $1"; }
check() { if "$@" >/dev/null 2>&1; then ok "$*"; else not_ok "$*"; fi; }

# ---- stub commands ----

cat >"$STUBS/sudo" <<'EOF'
#!/usr/bin/env bash
exec "$@"
EOF

cat >"$STUBS/systemctl" <<'EOF'
#!/usr/bin/env bash
: >>"${SYSTEMCTL_LOG:-/dev/null}"
printf '%s\n' "$*" >>"${SYSTEMCTL_LOG:-/dev/null}"
exit 0
EOF

# Logs npm invocations and enforces mutual exclusion via a marker file: if
# two npm stub invocations from two different deploy.sh runs are ever inside
# this block at once, that's the flock guardrail failing to serialize them.
cat >"$STUBS/npm" <<'EOF'
#!/usr/bin/env bash
marker="${CRIT_MARKER:-}"
if [ -n "$marker" ]; then
  if [ -e "$marker" ]; then
    echo "OVERLAP: $(cat "$marker") vs $$ at $(pwd) $*" >>"${OVERLAP_LOG:-/dev/null}"
  fi
  echo "$$" >"$marker"
fi
printf '%s %s\n' "$(pwd)" "$*" >>"${NPM_LOG:-/dev/null}"
sleep "${NPM_SLEEP:-0}"
# Mimics vite's `base` behavior: `npm run build` writes assets referencing
# $HORIZON_BASE. UI_BUILD_IGNORE_BASE lets a test simulate the HZ-19
# production bug where the build ran without HORIZON_BASE reaching it.
if [ "$1" = "run" ] && [ "$2" = "build" ]; then
  mkdir -p dist
  if [ -n "${UI_BUILD_IGNORE_BASE:-}" ]; then
    base="/"
  else
    base="${HORIZON_BASE:-/}"
  fi
  printf '<script type="module" src="%sassets/index.js"></script>\n' "$base" >dist/index.html
fi
[ -n "$marker" ] && rm -f "$marker"
exit 0
EOF

# Pops one "STATUS|BODY" line per invocation from $CURL_QUEUE_FILE (tracked
# via $CURL_STATE_FILE so retries advance); repeats the last line once the
# queue is exhausted. Mimics `curl -fsS`: 2xx prints the body and exits 0,
# anything else prints nothing and exits non-zero.
cat >"$STUBS/curl" <<'EOF'
#!/usr/bin/env bash
queue="${CURL_QUEUE_FILE:?}"
state="${CURL_STATE_FILE:?}"
n=1
[ -f "$state" ] && n=$(( $(cat "$state") + 1 ))
echo "$n" >"$state"
line="$(sed -n "${n}p" "$queue")"
[ -z "$line" ] && line="$(tail -n1 "$queue")"
status="${line%%|*}"
body="${line#*|}"
if [[ "$status" == 2* ]]; then
  printf '%s' "$body"
  exit 0
fi
exit 22
EOF

chmod +x "$STUBS"/sudo "$STUBS"/systemctl "$STUBS"/npm "$STUBS"/curl

# ---- throwaway git repo (server/ and ui/ are just stub package.json dirs;
# npm itself is stubbed so nothing real gets installed/built) ----

setup_repo() {
  local base="$1"
  local upstream="$base/upstream.git"
  local seed="$base/seed"
  git init --quiet --bare "$upstream"
  git clone --quiet "$upstream" "$seed" 2>/dev/null
  (
    cd "$seed" || exit 1
    git checkout --quiet -b main
    git config user.email test@example.com
    git config user.name "Deploy Test"
    mkdir -p server ui
    echo '{"name":"server-stub"}' >server/package.json
    echo '{"name":"ui-stub"}' >ui/package.json
    echo v1 >VERSION
    git add -A
    git commit --quiet -m v1
    git tag v1
    git push --quiet origin main
    git push --quiet origin --tags
  )
  git clone --quiet "$upstream" "$base/repo"
  echo "$base/repo"
}

success_queue() { printf '200|{"items":[]}\n' >"$1"; }

run_deploy() {
  # run_deploy REPO_DIR STATE_DIR TAG [extra env assignments...]
  local repo="$1" state="$2" tag="$3"
  shift 3
  env PATH="$STUBS:$PATH" \
    HORIZON_REPO_DIR="$repo" \
    HORIZON_STATE_DIR="$state" \
    HORIZON_SERVICE_NAME="horizon-server-test" \
    HORIZON_HEALTH_URL="http://stub.invalid/api/items" \
    HORIZON_HEALTH_TIMEOUT_S="5" \
    HORIZON_HEALTH_POLL_S="0.05" \
    HORIZON_DEPLOY_LOCK_TIMEOUT_S="10" \
    "$@" \
    "$DEPLOY_SH" "$tag"
}

# ---- 1. idempotency: running the same tag twice is safe ----
{
  base="$(mktemp -d)"
  repo="$(setup_repo "$base")"
  state="$base/state"
  curl_q="$base/curl.queue"
  success_queue "$curl_q"

  run_deploy "$repo" "$state" v1 \
    CURL_QUEUE_FILE="$curl_q" CURL_STATE_FILE="$base/curl1.state"
  first_exit=$?
  run_deploy "$repo" "$state" v1 \
    CURL_QUEUE_FILE="$curl_q" CURL_STATE_FILE="$base/curl2.state"
  second_exit=$?

  [ "$first_exit" -eq 0 ] && ok "idempotency: first run of v1 succeeds" || not_ok "idempotency: first run of v1 succeeds"
  [ "$second_exit" -eq 0 ] && ok "idempotency: second run of the same tag succeeds" || not_ok "idempotency: second run of the same tag succeeds"

  ok_lines=$(grep -c "DEPLOY OK" "$state/self-deploy.log" 2>/dev/null || echo 0)
  [ "$ok_lines" -eq 2 ] && ok "idempotency: both runs logged DEPLOY OK" || not_ok "idempotency: both runs logged DEPLOY OK (got $ok_lines)"

  sha="$(git -C "$repo" rev-parse HEAD)"
  grep -q "$sha" "$state/last-good-tag" && ok "idempotency: last-good-tag has the resolved commit" \
    || not_ok "idempotency: last-good-tag has the resolved commit"
  rm -rf "$base"
}

# ---- 2. lock serialization: two overlapping runs never enter npm at once ----
{
  base="$(mktemp -d)"
  repo="$(setup_repo "$base")"
  state="$base/state"
  curl_q="$base/curl.queue"
  success_queue "$curl_q"
  marker="$base/critical.marker"
  overlap_log="$base/overlap.log"
  npm_log="$base/npm.log"

  (
    run_deploy "$repo" "$state" v1 \
      CURL_QUEUE_FILE="$curl_q" CURL_STATE_FILE="$base/curl1.state" \
      CRIT_MARKER="$marker" OVERLAP_LOG="$overlap_log" NPM_LOG="$npm_log" NPM_SLEEP=0.3
    echo $? >"$base/run1.exit"
  ) &
  pid1=$!
  sleep 0.05 # let run1 acquire the lock first
  (
    run_deploy "$repo" "$state" v1 \
      CURL_QUEUE_FILE="$curl_q" CURL_STATE_FILE="$base/curl2.state" \
      CRIT_MARKER="$marker" OVERLAP_LOG="$overlap_log" NPM_LOG="$npm_log" NPM_SLEEP=0.3
    echo $? >"$base/run2.exit"
  ) &
  pid2=$!
  wait "$pid1" "$pid2"

  e1="$(cat "$base/run1.exit" 2>/dev/null)"
  e2="$(cat "$base/run2.exit" 2>/dev/null)"
  [ "$e1" = "0" ] && [ "$e2" = "0" ] && ok "lock: both overlapping runs eventually succeed (serialized, not dropped)" \
    || not_ok "lock: both overlapping runs eventually succeed (got e1=$e1 e2=$e2)"
  [ ! -s "$overlap_log" ] && ok "lock: no two npm invocations from different runs overlapped" \
    || not_ok "lock: no two npm invocations from different runs overlapped ($(cat "$overlap_log" 2>/dev/null))"
  [ ! -e "$marker" ] && ok "lock: critical-section marker cleaned up after both runs" \
    || not_ok "lock: critical-section marker cleaned up after both runs"
  rm -rf "$base"
}

# ---- 3. health-check failure exits non-zero and logs it, without recording last-good-tag ----
{
  base="$(mktemp -d)"
  repo="$(setup_repo "$base")"
  state="$base/state"
  curl_q="$base/curl.queue"
  printf '500|\n' >"$curl_q"

  run_deploy "$repo" "$state" v1 \
    CURL_QUEUE_FILE="$curl_q" CURL_STATE_FILE="$base/curl1.state"
  code=$?

  [ "$code" -ne 0 ] && ok "health-check failure: deploy.sh exits non-zero" || not_ok "health-check failure: deploy.sh exits non-zero"
  grep -q "DEPLOY FAILED: health-check" "$state/self-deploy.log" 2>/dev/null && \
    ok "health-check failure: DEPLOY FAILED is logged" || not_ok "health-check failure: DEPLOY FAILED is logged"
  [ ! -e "$state/last-good-tag" ] && ok "health-check failure: last-good-tag is not written" \
    || not_ok "health-check failure: last-good-tag is not written"
  rm -rf "$base"
}

# ---- 4. health-check retries within its budget before succeeding ----
{
  base="$(mktemp -d)"
  repo="$(setup_repo "$base")"
  state="$base/state"
  curl_q="$base/curl.queue"
  printf '500|\n500|\n200|{"items":[]}\n' >"$curl_q"

  run_deploy "$repo" "$state" v1 \
    CURL_QUEUE_FILE="$curl_q" CURL_STATE_FILE="$base/curl1.state"
  code=$?

  [ "$code" -eq 0 ] && ok "health-check retry: succeeds after two failed attempts" \
    || not_ok "health-check retry: succeeds after two failed attempts"
  grep -q "DEPLOY OK" "$state/self-deploy.log" 2>/dev/null && ok "health-check retry: DEPLOY OK logged" \
    || not_ok "health-check retry: DEPLOY OK logged"
  rm -rf "$base"
}

# ---- 5. an unresolvable/malicious tag is inert data, not executed, and falls back to origin/main ----
{
  base="$(mktemp -d)"
  repo="$(setup_repo "$base")"
  state="$base/state"
  curl_q="$base/curl.queue"
  success_queue "$curl_q"
  canary="$base/pwned"

  unsafe_tag='$(touch '"$canary"')'
  run_deploy "$repo" "$state" "$unsafe_tag" \
    CURL_QUEUE_FILE="$curl_q" CURL_STATE_FILE="$base/curl1.state"
  code=$?

  [ ! -e "$canary" ] && ok "unsafe tag: command-substitution-looking tag is never executed" \
    || not_ok "unsafe tag: command-substitution-looking tag is never executed"
  [ "$code" -eq 0 ] && ok "unsafe tag: falls back to origin/main and still succeeds" \
    || not_ok "unsafe tag: falls back to origin/main and still succeeds"
  grep -q "tag=origin/main" "$state/self-deploy.log" 2>/dev/null && ok "unsafe tag: log records the origin/main fallback" \
    || not_ok "unsafe tag: log records the origin/main fallback"
  rm -rf "$base"
}

# ---- 6. semicolon-bearing tag is also inert ----
{
  base="$(mktemp -d)"
  repo="$(setup_repo "$base")"
  state="$base/state"
  curl_q="$base/curl.queue"
  success_queue "$curl_q"
  canary="$base/pwned2"

  unsafe_tag="v1; touch $canary"
  run_deploy "$repo" "$state" "$unsafe_tag" \
    CURL_QUEUE_FILE="$curl_q" CURL_STATE_FILE="$base/curl1.state"

  [ ! -e "$canary" ] && ok "unsafe tag: semicolon-bearing tag is never executed" \
    || not_ok "unsafe tag: semicolon-bearing tag is never executed"
  rm -rf "$base"
}

# ---- 7. ui-build-verify: a build that didn't get HORIZON_BASE is caught
# before restart, instead of shipping root-path assets that 404 under /horizon
# (this is the HZ-19 production bug: HORIZON_BASE was scoped to `npm ci`
# instead of `npm run build`) ----
{
  base="$(mktemp -d)"
  repo="$(setup_repo "$base")"
  state="$base/state"
  curl_q="$base/curl.queue"
  success_queue "$curl_q"
  systemctl_log="$base/systemctl.log"

  run_deploy "$repo" "$state" v1 \
    CURL_QUEUE_FILE="$curl_q" CURL_STATE_FILE="$base/curl1.state" \
    SYSTEMCTL_LOG="$systemctl_log" UI_BUILD_IGNORE_BASE=1
  code=$?

  [ "$code" -ne 0 ] && ok "ui-build-verify: deploy.sh exits non-zero when the build lacks /horizon/assets/" \
    || not_ok "ui-build-verify: deploy.sh exits non-zero when the build lacks /horizon/assets/"
  grep -q "DEPLOY FAILED: ui-build-verify" "$state/self-deploy.log" 2>/dev/null && \
    ok "ui-build-verify: DEPLOY FAILED is logged" || not_ok "ui-build-verify: DEPLOY FAILED is logged"
  [ ! -s "$systemctl_log" ] && ok "ui-build-verify: service is never restarted on a bad build" \
    || not_ok "ui-build-verify: service is never restarted on a bad build ($(cat "$systemctl_log" 2>/dev/null))"
  rm -rf "$base"
}

# ---- 8. ui-build-verify passes and the service restarts when the build
# correctly references /horizon/assets/ ----
{
  base="$(mktemp -d)"
  repo="$(setup_repo "$base")"
  state="$base/state"
  curl_q="$base/curl.queue"
  success_queue "$curl_q"
  systemctl_log="$base/systemctl.log"

  run_deploy "$repo" "$state" v1 \
    CURL_QUEUE_FILE="$curl_q" CURL_STATE_FILE="$base/curl1.state" \
    SYSTEMCTL_LOG="$systemctl_log"
  code=$?

  [ "$code" -eq 0 ] && ok "ui-build-verify: deploy succeeds when the build references /horizon/assets/" \
    || not_ok "ui-build-verify: deploy succeeds when the build references /horizon/assets/"
  grep -q "restart horizon-server-test" "$systemctl_log" 2>/dev/null && \
    ok "ui-build-verify: service is restarted after a correct build" \
    || not_ok "ui-build-verify: service is restarted after a correct build"
  rm -rf "$base"
}

# ---- 9. health check handles a response body well past the ~128KB argv
# limit (this is the other HZ-19 production bug: the body used to be passed
# to node as argv, which dies with "Argument list too long" on any real
# database; it must be piped via stdin instead) ----
{
  base="$(mktemp -d)"
  repo="$(setup_repo "$base")"
  state="$base/state"
  curl_q="$base/curl.queue"
  padding="$(head -c 250000 /dev/zero | tr '\0' 'x')"
  printf '200|{"items":[],"padding":"%s"}\n' "$padding" >"$curl_q"

  run_deploy "$repo" "$state" v1 \
    CURL_QUEUE_FILE="$curl_q" CURL_STATE_FILE="$base/curl1.state"
  code=$?

  [ "$code" -eq 0 ] && ok "large body: health check succeeds on a >200KB response body" \
    || not_ok "large body: health check succeeds on a >200KB response body"
  grep -q "DEPLOY OK" "$state/self-deploy.log" 2>/dev/null && ok "large body: DEPLOY OK logged" \
    || not_ok "large body: DEPLOY OK logged"
  rm -rf "$base"
}

# ---- 10. health-check failure log carries the actual underlying error, not
# just a generic message ----
{
  base="$(mktemp -d)"
  repo="$(setup_repo "$base")"
  state="$base/state"
  curl_q="$base/curl.queue"
  printf '200|not valid json\n' >"$curl_q"

  run_deploy "$repo" "$state" v1 \
    CURL_QUEUE_FILE="$curl_q" CURL_STATE_FILE="$base/curl1.state"

  grep -q "DEPLOY FAILED: health-check" "$state/self-deploy.log" 2>/dev/null && \
    grep -Eq "not valid JSON|Unexpected token" "$state/self-deploy.log" 2>/dev/null && \
    ok "health-check failure log: carries the underlying parse error" \
    || not_ok "health-check failure log: carries the underlying parse error ($(cat "$state/self-deploy.log" 2>/dev/null | tail -1))"
  rm -rf "$base"
}

# ---- 11. farm isolation, by construction: deploy.sh never references the farm ----
if ! grep -Eiq 'horizon-farm|\.horizon-farm|(^|[^a-z])farm/' "$DEPLOY_SH"; then
  ok "farm isolation: deploy.sh contains no horizon-farm/farm references"
else
  not_ok "farm isolation: deploy.sh contains no horizon-farm/farm references"
fi

echo "1..$((pass + fail))"
echo "# pass $pass"
echo "# fail $fail"
[ "$fail" -eq 0 ]
