#!/usr/bin/env bash
# Behavioral test harness for infra/host/deploy-grpc-service.sh and its
# deploy-<service>.sh wrappers. Same approach as deploy.test.sh: the external
# commands (cargo, sudo, systemctl, curl) are stubs on PATH and each run
# points at a throwaway git repo; git itself runs for real. Also checks that
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

cat >"$STUBS/systemctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${SYSTEMCTL_LOG:-/dev/null}"
EOF

# CARGO_FAIL=1 simulates a compile error.
cat >"$STUBS/cargo" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${BUILD_LOG:-/dev/null}"
[ -z "${CARGO_FAIL:-}" ]
EOF

# Replies with a gRPC HealthCheckResponse frame: SERVING (status 1) unless
# HEALTH_STATUS says otherwise; HEALTH_DOWN=1 is a refused connection.
cat >"$STUBS/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${CURL_LOG:-/dev/null}"
if [ -n "${HEALTH_DOWN:-}" ]; then
  echo "curl: (7) Failed to connect" >&2
  exit 7
fi
printf "\\x00\\x00\\x00\\x00\\x02\\x08\\x0${HEALTH_STATUS:-1}"
EOF

chmod +x "$STUBS"/*

setup_repo() {
  # setup_repo BASE_DIR — a bare upstream with main tagged v1, and a clone.
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
    "$HOST_DIR/$script" "$tag" >/dev/null 2>&1
}

new_base() {
  local base
  base="$(mktemp -d "$WORK/run.XXXX")"
  mkdir -p "$base/home"
  setup_repo "$base"
  echo "$base"
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

echo "# deploy-grpc-service: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
