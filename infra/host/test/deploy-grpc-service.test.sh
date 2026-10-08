#!/usr/bin/env bash
# Behavioral test harness for infra/host/deploy-grpc-service.sh and its
# deploy-<service>.sh wrappers. Same approach as deploy.test.sh: the external
# commands (cargo, sudo, systemctl, curl) are stubs on PATH and each run
# points at a throwaway git repo; git runs for real behind a stub that refuses
# any non-local fetch. Also checks that
# every wrapper's unit is in horizon-deploy.sudoers and its unit file listens
# on the port the health check probes.
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

cat >"$STUBS/sudo" <<'EOF'
#!/usr/bin/env bash
exec "$@"
EOF

# SYSTEMCTL_FAIL_CALL=<n> fails the nth call. EVENT_LOG/RUN_ID record the
# order of builds and restarts across concurrent runs.
cat >"$STUBS/systemctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${SYSTEMCTL_LOG:-/dev/null}"
printf '%s restart\n' "${RUN_ID:-}" >>"${EVENT_LOG:-/dev/null}"
if [ -n "${SYSTEMCTL_FAIL_CALL:-}" ] && [ -n "${SYSTEMCTL_LOG:-}" ] \
    && [ "$(wc -l <"$SYSTEMCTL_LOG")" -eq "$SYSTEMCTL_FAIL_CALL" ]; then
  exit 1
fi
EOF

# CARGO_FAIL=1 simulates a compile error; CARGO_FAIL_REF=<tag> fails only that
# tag's build and CARGO_SLEEP_REF=<tag> makes it take 2s.
cat >"$STUBS/cargo" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${BUILD_LOG:-/dev/null}"
printf '%s build\n' "${RUN_ID:-}" >>"${EVENT_LOG:-/dev/null}"
at() { [ -n "$1" ] && [ "$(git rev-parse HEAD)" = "$(git rev-parse -q --verify "$1^{commit}")" ]; }
if at "${CARGO_SLEEP_REF:-}"; then sleep 2; fi
if at "${CARGO_FAIL_REF:-}"; then exit 1; fi
[ -z "${CARGO_FAIL:-}" ]
EOF

# Replies with a gRPC HealthCheckResponse frame: SERVING (status 1) unless
# HEALTH_STATUS says otherwise (for every commit); HEALTH_BAD_REF=<tag>
# replies NOT_SERVING only while the repo is at that tag; HEALTH_DOWN=1 is
# a refused connection.
cat >"$STUBS/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${CURL_LOG:-/dev/null}"
if [ -n "${HEALTH_DOWN:-}" ]; then
  echo "curl: (7) Failed to connect" >&2
  exit 7
fi
status="${HEALTH_STATUS:-1}"
if [ -n "${HEALTH_BAD_REF:-}" ] && [ "$(git -C "$HORIZON_REPO_DIR" rev-parse HEAD)" \
    = "$(git -C "$HORIZON_REPO_DIR" rev-parse -q --verify "$HEALTH_BAD_REF^{commit}")" ]; then
  status=2
fi
printf "\\x00\\x00\\x00\\x00\\x02\\x08\\x0${status}"
EOF

# Real git for local repos only: a fetch whose origin is not a local path fails.
REAL_GIT="$(command -v git)"
cat >"$STUBS/git" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = fetch ]; then
  case "\$("$REAL_GIT" remote get-url origin 2>/dev/null)" in
    /*) ;;
    *) echo "stub git: refusing a non-local fetch" >&2; exit 97 ;;
  esac
fi
exec "$REAL_GIT" "\$@"
EOF

chmod +x "$STUBS"/*

setup_repo() {
  # setup_repo BASE_DIR — a bare upstream with main tagged v1 and v2, and a clone.
  local base="$1"
  git init --quiet --bare --initial-branch=main "$base/upstream.git"
  git clone --quiet "$base/upstream.git" "$base/seed" 2>/dev/null
  (
    cd "$base/seed" || exit 1
    git checkout --quiet -b main
    git config user.email test@example.com
    git config user.name "Deploy Test"
    echo "$base" >LABEL
    git add -A
    git commit --quiet -m v1
    git tag v1
    echo v2 >VERSION
    git add -A
    git commit --quiet -m v2
    git tag v2
    git push --quiet origin main --tags
  )
  git clone --quiet "$base/upstream.git" "$base/repo"
}

run_wrapper() {
  # run_wrapper SCRIPT BASE TAG [extra env assignments...]
  local script="$1" base="$2" tag="$3"
  shift 3
  env PATH="$STUBS:$PATH" HOME="$base/home" \
    HORIZON_REPO_DIR="$base/repo" \
    HORIZON_STATE_DIR="$base/state" \
    HORIZON_SERVICE_NAME="grpc-test" \
    HORIZON_HEALTH_TIMEOUT_S=1 \
    HORIZON_HEALTH_POLL_S=0.1 \
    HORIZON_DEPLOY_LOCK_TIMEOUT_S=5 \
    BUILD_LOG="$base/build.log" SYSTEMCTL_LOG="$base/systemctl.log" CURL_LOG="$base/curl.log" \
    "$@" \
    timeout 30 "$HOST_DIR/$script" "$tag" >/dev/null 2>&1
}

new_base() {
  local base
  base="$(mktemp -d "$WORK/run.XXXX")"
  mkdir -p "$base/home"
  setup_repo "$base"
  echo "$base"
}

seed_last_good() {
  # seed_last_good BASE TAG — writes last-good-tag as a past deploy would, and
  # keeps a copy to compare against.
  local base="$1" tag="$2"
  mkdir -p "$base/state"
  printf 'refs/tags/%s:%s\n' "$tag" "$(git -C "$base/seed" rev-parse "$tag")" >"$base/state/last-good-tag"
  cp "$base/state/last-good-tag" "$base/last-good-tag.seeded"
}

count() { grep -c -- "$1" "$2" 2>/dev/null || true; }

# ---- 0. the runs only ever reach stubs and temp dirs ----
{
  for cmd in systemctl sudo git cargo curl; do
    expect "isolation: $cmd resolves to the stub" test "$(PATH="$STUBS:$PATH" command -v "$cmd")" = "$STUBS/$cmd"
  done
  base="$(new_base)"
  expect "isolation: HOME and HORIZON_STATE_DIR are temp dirs" test "${base#"$WORK"/}" != "$base"
  expect "isolation: temp dirs are not under ~/.horizon" test "${WORK#"$HOME/.horizon"}" = "$WORK"
  expect "syntax: bash -n deploy-grpc-service.sh" bash -n "$HOST_DIR/deploy-grpc-service.sh"
}

# ---- 1. a release tag builds, restarts, sees SERVING and records last-good ----
{
  base="$(new_base)"
  run_wrapper deploy-broker-service.sh "$base" v1
  code=$?
  sha="$(git -C "$base/seed" rev-parse v1)"
  expect "ok: exits 0" test "$code" -eq 0
  expect "ok: checks out the release tag" test "$(git -C "$base/repo" rev-parse HEAD)" = "$sha"
  expect "ok: builds the broker server binary" grep -qx "build --release --bin broker-service-server" "$base/build.log"
  expect "ok: restarts the unit" grep -qx "restart grpc-test" "$base/systemctl.log"
  expect "ok: probes grpc.health.v1.Health/Check on the HEALTH_URL" grep -q "/grpc.health.v1.Health/Check" "$base/curl.log"
  expect "ok: logs DEPLOY OK" grep -q "DEPLOY OK tag=refs/tags/v1 commit=$sha" "$base/state/self-deploy.log"
  expect "ok: records last-good-tag" grep -qx "refs/tags/v1:$sha" "$base/state/last-good-tag"
}

# ---- 2. NOT_SERVING fails the health check ----
{
  base="$(new_base)"
  run_wrapper deploy-valuation-service.sh "$base" v1 HEALTH_STATUS=2
  code=$?
  expect "not serving: exits non-zero" test "$code" -ne 0
  expect "not serving: logs the reply bytes" grep -q "DEPLOY FAILED: health-check .*not SERVING (bytes: 00000000020802)" "$base/state/self-deploy.log"
  expect "not serving: no last-good-tag" test ! -e "$base/state/last-good-tag"
}

# ---- 3. a server that never comes up fails the health check ----
{
  base="$(new_base)"
  run_wrapper deploy-valuation-service.sh "$base" v1 HEALTH_DOWN=1
  code=$?
  expect "down: exits non-zero" test "$code" -ne 0
  expect "down: logs DEPLOY FAILED: health-check" grep -q "DEPLOY FAILED: health-check" "$base/state/self-deploy.log"
}

# ---- 4. a failed build stops before the restart ----
{
  base="$(new_base)"
  run_wrapper deploy-broker-service.sh "$base" v1 CARGO_FAIL=1
  code=$?
  expect "build failure: exits non-zero" test "$code" -ne 0
  expect "build failure: logs DEPLOY FAILED: build" grep -q "DEPLOY FAILED: build" "$base/state/self-deploy.log"
  expect "build failure: never restarts the unit" test ! -s "$base/systemctl.log"
}

# ---- 5. an unknown tag deploys the wrapper's default branch ----
{
  base="$(new_base)"
  run_wrapper deploy-valuation-service.sh "$base" no-such-tag
  code=$?
  expect "fallback: exits 0" test "$code" -eq 0
  expect "fallback: deploys origin/main" test "$(git -C "$base/repo" rev-parse HEAD)" = "$(git -C "$base/seed" rev-parse main)"
}

# ---- 6. each wrapper's unit is allowed and listens where it is probed ----
for wrapper in "$HOST_DIR"/deploy-*.sh; do
  grep -q 'deploy-grpc-service.sh' "$wrapper" || continue
  name="$(basename "$wrapper")"
  service="$(sed -n 's/^export DEPLOY_SERVICE=//p' "$wrapper")"
  port="$(sed -n 's|^export DEPLOY_HEALTH_URL=http://127.0.0.1:\([0-9]*\)/$|\1|p' "$wrapper")"
  unit="$HOST_DIR/$service.service"
  expect "$name: $service is in horizon-deploy.sudoers" grep -qx "ubuntu ALL=(root) NOPASSWD: /bin/systemctl restart $service" "$HOST_DIR/horizon-deploy.sudoers"
  expect "$name: unit file $service.service exists" test -f "$unit"
  expect "$name: unit listens on probed port $port" grep -qE "^Environment=[A-Z_]*PORT=$port$" "$unit"
done

# ---- 7. a bad release rolls back to last-good-tag (metric 1, 3) ----
{
  base="$(new_base)"
  seed_last_good "$base" v1
  v1="$(git -C "$base/seed" rev-parse v1)"
  v2="$(git -C "$base/seed" rev-parse v2)"
  refs_before="$(git -C "$base/repo" show-ref)"
  run_wrapper deploy-broker-service.sh "$base" v2 HEALTH_BAD_REF=v2 HZ342_SENTINEL=s3ntinel-value
  code=$?
  log="$base/state/self-deploy.log"
  expect "rollback ok: run ends (no timeout)" test "$code" -ne 124
  expect "rollback ok: exits non-zero" test "$code" -ne 0
  expect "rollback ok: HEAD is back at v1" test "$(git -C "$base/repo" rev-parse HEAD)" = "$v1"
  expect "rollback ok: HEAD is detached" bash -c "! git -C '$base/repo' symbolic-ref -q HEAD"
  expect "rollback ok: rebuilt (2 builds)" test "$(count . "$base/build.log")" -eq 2
  expect "rollback ok: restarted twice" test "$(count "^restart grpc-test$" "$base/systemctl.log")" -eq 2
  expect "rollback ok: logs ROLLBACK OK" grep -q "ROLLBACK OK tag=refs/tags/v1 after refs/tags/v2$" "$log"
  expect "rollback ok: DEPLOY FAILED names the release and the rollback" grep -q "DEPLOY FAILED: health-check (tag=refs/tags/v2 commit=$v2) .*; rolling back to refs/tags/v1$" "$log"
  # ---- 9. the deploy step still reads as failed (metric 3) ----
  expect "rollback ok: DEPLOY FAILED matches deployOutcomeFor()" grep -qE "DEPLOY FAILED: .*\(tag=(refs/tags/)?v2[) ]" "$log"
  expect "rollback ok: exactly one DEPLOY FAILED" test "$(count "DEPLOY FAILED" "$log")" -eq 1
  expect "rollback ok: last line is not DEPLOY OK" bash -c "! tail -n1 '$log' | grep -q 'DEPLOY OK'"
  expect "rollback ok: never logs DEPLOY OK" bash -c "! grep -q 'DEPLOY OK' '$log'"
  expect "rollback ok: last-good-tag unchanged" cmp "$base/state/last-good-tag" "$base/last-good-tag.seeded"
  expect "rollback ok: tags and refs unchanged" test "$(git -C "$base/repo" show-ref)" = "$refs_before"
  expect "rollback ok: no env value in state" bash -c "! grep -rq s3ntinel-value '$base/state'"
}

# ---- 8. a failed rollback names its stage, once, and exits (metric 2, 3) ----
rollback_fail_case() {
  # rollback_fail_case STAGE [extra env...] — bad v2 over good v1, fresh dirs.
  local stage="$1" code log
  shift
  base="$(new_base)"
  seed_last_good "$base" v1
  run_wrapper deploy-broker-service.sh "$base" v2 HEALTH_BAD_REF=v2 HZ342_SENTINEL=s3ntinel-value "$@"
  code=$?
  log="$base/state/self-deploy.log"
  expect "$stage: run ends (no timeout)" test "$code" -ne 124
  expect "$stage: exits non-zero" test "$code" -ne 0
  expect "$stage: logs ROLLBACK FAILED ($stage)" grep -q "ROLLBACK FAILED ($stage) tag=refs/tags/v1 after refs/tags/v2" "$log"
  expect "$stage: exactly one ROLLBACK line" test "$(count "ROLLBACK" "$log")" -eq 1
  expect "$stage: exactly one DEPLOY FAILED line" test "$(count "DEPLOY FAILED" "$log")" -eq 1
  expect "$stage: DEPLOY FAILED matches deployOutcomeFor()" grep -qE "DEPLOY FAILED: .*\(tag=(refs/tags/)?v2[) ]" "$log"
  expect "$stage: never logs DEPLOY OK" bash -c "! grep -q 'DEPLOY OK' '$log'"
  expect "$stage: last-good-tag unchanged" cmp "$base/state/last-good-tag" "$base/last-good-tag.seeded"
  expect "$stage: no env value in state" bash -c "! grep -rq s3ntinel-value '$base/state'"
}
rollback_fail_case rollback-build CARGO_FAIL_REF=v1
expect "rollback-build: never restarts the old build" test "$(count "^restart" "$base/systemctl.log")" -eq 1
rollback_fail_case rollback-restart SYSTEMCTL_FAIL_CALL=2
expect "rollback-restart: one restart attempt only" test "$(count "^restart" "$base/systemctl.log")" -eq 2
# HEALTH_STATUS=2 fails health for every commit (the stub applies it to all),
# so the rollback's own health check fails too.
rollback_fail_case rollback-health-check HEALTH_STATUS=2
expect "rollback-health-check: exactly 2 restarts" test "$(count "^restart" "$base/systemctl.log")" -eq 2
expect "rollback-health-check: exactly 2 builds" test "$(count . "$base/build.log")" -eq 2
# A last good commit missing from the checkout cannot be checked out.
{
  base="$(new_base)"
  printf 'refs/tags/v0:%s\n' 0123456789abcdef0123456789abcdef01234567 >"$base/last-good-tag.seeded"
  mkdir -p "$base/state" && cp "$base/last-good-tag.seeded" "$base/state/last-good-tag"
  run_wrapper deploy-broker-service.sh "$base" v2 HEALTH_BAD_REF=v2
  code=$?
  expect "rollback-checkout: exits non-zero" test "$code" -ne 0 -a "$code" -ne 124
  expect "rollback-checkout: logs ROLLBACK FAILED (rollback-checkout)" grep -q "ROLLBACK FAILED (rollback-checkout) tag=refs/tags/v0 after refs/tags/v2" "$base/state/self-deploy.log"
  expect "rollback-checkout: one restart only" test "$(count "^restart" "$base/systemctl.log")" -eq 1
  expect "rollback-checkout: HEAD stays at v2" test "$(git -C "$base/repo" rev-parse HEAD)" = "$(git -C "$base/seed" rev-parse v2)"
}

# ---- 10. a failure before the restart never restarts or rolls back (metric 4) ----
pre_restart_case() {
  # pre_restart_case NAME STAGE SCRIPT TAG [extra env...]
  local name="$1" stage="$2" script="$3" tag="$4" code
  shift 4
  run_wrapper "$script" "$base" "$tag" "$@"
  code=$?
  expect "$name: exits non-zero" test "$code" -ne 0 -a "$code" -ne 124
  expect "$name: logs DEPLOY FAILED: $stage" grep -q "DEPLOY FAILED: $stage" "$base/state/self-deploy.log"
  expect "$name: never restarts the unit" test ! -s "$base/systemctl.log"
  expect "$name: no ROLLBACK line" bash -c "! grep -q ROLLBACK '$base/state/self-deploy.log'"
  expect "$name: last-good-tag unchanged" cmp "$base/state/last-good-tag" "$base/last-good-tag.seeded"
}
base="$(new_base)"; seed_last_good "$base" v1
pre_restart_case "pre-restart build" build deploy-broker-service.sh v2 CARGO_FAIL=1
base="$(new_base)"; seed_last_good "$base" v1
mv "$base/upstream.git" "$base/upstream.moved"
pre_restart_case "pre-restart fetch" fetch deploy-broker-service.sh v2
base="$(new_base)"; seed_last_good "$base" v1
pre_restart_case "pre-restart checkout" checkout deploy-broker-service.sh no-such-tag DEPLOY_DEFAULT_REF=origin/nope

# ---- 11. no last-good-tag: says it cannot roll back (metric 5) ----
{
  base="$(new_base)"
  run_wrapper deploy-broker-service.sh "$base" v2 HEALTH_BAD_REF=v2
  code=$?
  log="$base/state/self-deploy.log"
  expect "first deploy: exits non-zero" test "$code" -ne 0 -a "$code" -ne 124
  expect "first deploy: logs ROLLBACK SKIPPED" grep -q "ROLLBACK SKIPPED: no last-good-tag (after refs/tags/v2)" "$log"
  expect "first deploy: DEPLOY FAILED says it cannot roll back" grep -q "DEPLOY FAILED: health-check (tag=refs/tags/v2 .*; cannot roll back: no last-good-tag$" "$log"
  expect "first deploy: one restart only" test "$(count "^restart" "$base/systemctl.log")" -eq 1
  expect "first deploy: still no last-good-tag" test ! -e "$base/state/last-good-tag"
}
{
  base="$(new_base)"
  mkdir -p "$base/state"
  echo garbage >"$base/state/last-good-tag"
  cp "$base/state/last-good-tag" "$base/last-good-tag.seeded"
  run_wrapper deploy-broker-service.sh "$base" v2 HEALTH_BAD_REF=v2
  code=$?
  expect "malformed last-good: exits 1" test "$code" -eq 1
  expect "malformed last-good: logs ROLLBACK SKIPPED" grep -q "ROLLBACK SKIPPED: no last-good-tag" "$base/state/self-deploy.log"
  expect "malformed last-good: one restart only" test "$(count "^restart" "$base/systemctl.log")" -eq 1
  expect "malformed last-good: file unchanged" cmp "$base/state/last-good-tag" "$base/last-good-tag.seeded"
}

# ---- 12. the deploy lock is held until the rollback ends (metric 6) ----
{
  base="$(new_base)"
  seed_last_good "$base" v1
  events="$base/events.log"
  run_wrapper deploy-broker-service.sh "$base" v2 HEALTH_BAD_REF=v2 CARGO_SLEEP_REF=v1 \
    RUN_ID=A EVENT_LOG="$events" &
  pid_a=$!
  for _ in $(seq 100); do
    grep -q "rolling back" "$base/state/self-deploy.log" 2>/dev/null && break
    sleep 0.1
  done
  expect "lock: A reached its rollback" grep -q "rolling back" "$base/state/self-deploy.log"
  expect "lock: A is still running when B starts" kill -0 "$pid_a"
  run_wrapper deploy-broker-service.sh "$base" v1 RUN_ID=B EVENT_LOG="$events" \
    HORIZON_DEPLOY_LOCK_TIMEOUT_S=10
  code_b=$?
  wait "$pid_a"
  code_a=$?
  expect "lock: A exits non-zero" test "$code_a" -ne 0 -a "$code_a" -ne 124
  expect "lock: B exits 0 after A" test "$code_b" -eq 0
  a_restart2="$(grep -n '^A restart$' "$events" | sed -n 2p | cut -d: -f1)"
  b_first="$(grep -n '^B ' "$events" | head -n1 | cut -d: -f1)"
  expect "lock: A restarted twice" test -n "$a_restart2"
  expect "lock: every B event comes after A's rollback restart" test "${b_first:-0}" -gt "${a_restart2:-999}"
  expect "lock: A's ROLLBACK OK is logged before B's DEPLOY OK" bash -c \
    "grep -n -e 'ROLLBACK OK' -e 'DEPLOY OK' '$base/state/self-deploy.log' | head -n1 | grep -q 'ROLLBACK OK'"
}

# ---- 13. every gRPC wrapper runs the shared script (metric 7) ----
for name in deploy-ledger-service.sh deploy-valuation-service.sh deploy-broker-service.sh deploy-price-service.sh; do
  expect "$name: exists" test -f "$HOST_DIR/$name"
  expect "$name: execs deploy-grpc-service.sh" grep -qE '^exec .*/deploy-grpc-service\.sh" "\$@"$' "$HOST_DIR/$name"
done

echo "# deploy-grpc-service: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
