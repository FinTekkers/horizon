#!/usr/bin/env bash
# HZ-250: deploy-horizon.sh's drain stage, end to end through the real script.
# Same approach as deploy.test.sh (stubbed npm/sudo/systemctl/curl on PATH, a
# throwaway git repo, git itself real), plus a stub drain server: a small node
# HTTP server standing in for horizon-server's /api/farm/deploy-drain routes,
# which records every request with a timestamp. The stub systemctl records its
# timestamps too, so the tests can prove `restart` waits for the drain.
#
# Its own file so deploy.test.sh — the guardrail suite for the pre-existing
# deploy behaviour — stays unedited. Wired into the root `npm test`.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HORIZON_DEPLOY_SH="$HERE/../deploy-horizon.sh"
WORK="$(mktemp -d)"
STUBS="$WORK/stubs"
mkdir -p "$STUBS"
STUB_PIDS=()
cleanup() {
  for pid in "${STUB_PIDS[@]}"; do kill "$pid" 2>/dev/null; done
  rm -rf "$WORK"
}
trap cleanup EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }
not_ok() { fail=$((fail + 1)); echo "not ok - $1"; }
expect() { local name="$1"; shift; if "$@"; then ok "$name"; else not_ok "$name"; fi; }
# lt A B: true when float A < B.
lt() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a < b) }'; }

# ---- stub commands ----

cat >"$STUBS/sudo" <<'EOF'
#!/usr/bin/env bash
exec "$@"
EOF

cat >"$STUBS/systemctl" <<'EOF'
#!/usr/bin/env bash
printf '%s %s\n' "$(date +%s.%N)" "$*" >>"${SYSTEMCTL_LOG:-/dev/null}"
[ -n "${SYSTEMCTL_FAIL_RESTART:-}" ] && [ "$1" = "restart" ] && exit 1
exit 0
EOF

cat >"$STUBS/npm" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "run" ] && [ "$2" = "build" ]; then
  mkdir -p dist
  printf '<script type="module" src="%sassets/index.js"></script>\n' "${HORIZON_BASE:-/}" >dist/index.html
fi
exit 0
EOF

cat >"$STUBS/curl" <<'EOF'
#!/usr/bin/env bash
printf '{"ok":true,"itemCount":0}'
EOF

chmod +x "$STUBS"/*

# The stub drain server. Scenarios:
#   clears          begin lists HZ-T1; the first 2 polls list it, then none
#   mixed           begin lists HZ-T1 + HZ-T2; from poll 2 only HZ-T2 is left
#   one             HZ-T1 is listed forever
#   hang            accepts every connection and never answers
#   hang-interrupt  like `one`, but the interrupt request never answers
#   echo500         every request gets a 500 whose body echoes the headers
cat >"$WORK/stub-drain.mjs" <<'EOF'
import http from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'
const [scenario, logFile, portFile, secret] = process.argv.slice(2)
const T1 = { itemId: 'HZ-T1', kind: 'premerge', startedAt: '2026-10-02T12:00:00.000Z' }
const T2 = { itemId: 'HZ-T2', kind: 'resolve', startedAt: '2026-10-02T12:00:01.000Z' }
const initial = scenario === 'mixed' ? [T1, T2] : [T1]
let polls = 0
const listed = () => {
  if (scenario === 'clears') return polls <= 2 ? [T1] : []
  if (scenario === 'mixed') return polls <= 1 ? [T1, T2] : [T2]
  return [T1]
}
const record = (req, extra = '') => {
  const auth = req.headers['x-farm-secret'] === secret ? 'auth=ok' : 'auth=bad'
  appendFileSync(logFile, `${(Date.now() / 1000).toFixed(3)} ${req.method} ${req.url} ${auth} ${extra}\n`)
}
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    const send = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (scenario === 'hang') return record(req)
    if (scenario === 'echo500') {
      record(req)
      return send(500, { error: 'boom', headers: req.headers, body })
    }
    if (req.method === 'POST' && req.url.endsWith('/interrupt')) {
      record(req, body)
      if (scenario === 'hang-interrupt') return
      return send(200, { interrupted: JSON.parse(body).runs.map((r) => ({ ...r, killed: true })) })
    }
    if (req.method === 'POST') {
      record(req, body)
      return send(200, { blocked: true, blockedUntil: '2026-10-02T13:00:00.000Z', running: initial })
    }
    if (req.method === 'GET') {
      polls++
      const running = listed()
      record(req, `running=${running.length}`)
      return send(200, { blocked: true, running })
    }
    record(req)
    return send(200, { blocked: false })
  })
})
server.listen(0, '127.0.0.1', () => writeFileSync(portFile, String(server.address().port)))
EOF

# start_stub SCENARIO LOG SECRET -> sets $url. Not called in $(...): the
# backgrounded server would hold the substitution's stdout open forever.
start_stub() {
  local scenario="$1" log="$2" secret="$3" port_file
  port_file="$(mktemp -p "$WORK")"
  rm -f "$port_file"
  node "$WORK/stub-drain.mjs" "$scenario" "$log" "$port_file" "$secret" >/dev/null 2>&1 &
  STUB_PIDS+=("$!")
  for _ in $(seq 1 200); do [ -s "$port_file" ] && break; sleep 0.05; done
  url="http://127.0.0.1:$(cat "$port_file")/api/farm/deploy-drain"
}

setup_repo() {
  local base="$1"
  git init --quiet --bare "$base/upstream.git"
  git clone --quiet "$base/upstream.git" "$base/seed" 2>/dev/null
  (
    cd "$base/seed" || exit 1
    git checkout --quiet -b main
    git config user.email test@example.com
    git config user.name "Deploy Test"
    mkdir -p server ui
    echo '{"name":"server-stub"}' >server/package.json
    echo '{"name":"ui-stub"}' >ui/package.json
    echo "$base" >LABEL
    git add -A
    git commit --quiet -m v1
    git tag v1
    git push --quiet origin main
    git push --quiet origin --tags
  )
  git clone --quiet "$base/upstream.git" "$base/repo" 2>/dev/null
}

# run_deploy BASE DRAIN_URL [extra env assignments...]
run_deploy() {
  local base="$1" url="$2"
  shift 2
  env PATH="$STUBS:$PATH" \
    HORIZON_REPO_DIR="$base/repo" \
    HORIZON_STATE_DIR="$base/state" \
    HORIZON_SERVICE_NAME="horizon-server-test" \
    HORIZON_HEALTH_URL="http://stub.invalid/api/health" \
    HORIZON_HEALTH_TIMEOUT_S="5" \
    HORIZON_HEALTH_POLL_S="0.05" \
    HORIZON_DEPLOY_LOCK_TIMEOUT_S="10" \
    HORIZON_DEPLOY_DRAIN_URL="$url" \
    SYSTEMCTL_LOG="$base/systemctl.log" \
    "$@" \
    "$HORIZON_DEPLOY_SH" v1 >>"$base/deploy.out" 2>&1
}

restart_ts() { awk '$2 == "restart" && $3 == "horizon-server-test" { print $1; exit }' "$1/systemctl.log" 2>/dev/null; }

# ---- 1. M1: restart waits while a run is listed, and follows within one poll of it clearing ----
{
  base="$(mktemp -d -p "$WORK")"
  setup_repo "$base"
  start_stub clears "$base/drain.log" s3cret
  run_deploy "$base" "$url" FARM_SHARED_SECRET=s3cret HORIZON_DEPLOY_DRAIN_POLL_S=1 HORIZON_DEPLOY_DRAIN_TIMEOUT_S=30
  code=$?
  last_listed="$(awk '$2 == "GET" && /running=1/ { t = $1 } END { print t }' "$base/drain.log")"
  cleared="$(awk '$2 == "GET" && /running=0/ { print $1; exit }' "$base/drain.log")"
  restarted="$(restart_ts "$base")"
  expect "M1: deploy succeeds after the drain" [ "$code" -eq 0 ]
  expect "M1: the run was listed for 2 polls, then cleared" [ "$(grep -c 'GET .*running=1' "$base/drain.log")" -eq 2 ]
  expect "M1: no restart while the run was listed" lt "$last_listed" "$restarted"
  expect "M1: restart only after the run cleared" lt "$cleared" "$restarted"
  expect "M1: restart within 1 poll + 1s of the run clearing ($cleared -> $restarted)" lt "$restarted" "$(awk -v c="$cleared" 'BEGIN { printf "%.3f", c + 2 }')"
  expect "M1: the drain authenticated with the farm secret" bash -c "! grep -q 'auth=bad' '$base/drain.log'"
  expect "M1: nothing was interrupted" bash -c "! grep -q '/interrupt' '$base/drain.log'"
}

# ---- 2. M2: the real self-deploy.log names every run waited for and how it ended ----
{
  base="$(mktemp -d -p "$WORK")"
  setup_repo "$base"
  start_stub mixed "$base/drain.log" s3cret
  run_deploy "$base" "$url" FARM_SHARED_SECRET=s3cret HORIZON_DEPLOY_DRAIN_POLL_S=0.5 HORIZON_DEPLOY_DRAIN_TIMEOUT_S=2
  code=$?
  log="$base/state/self-deploy.log"
  expect "M2: deploy succeeds after a timed-out drain" [ "$code" -eq 0 ]
  expect "M2: log names both runs waited for" grep -q 'DRAIN waiting up to 2s for 2 run(s): HZ-T1 premerge, HZ-T2 resolve' "$log"
  expect "M2: log says HZ-T1 finished" grep -q 'DRAIN finished: HZ-T1 premerge$' "$log"
  expect "M2: log says HZ-T2 timed out and was interrupted" grep -q 'DRAIN timed out: HZ-T2 resolve — interrupted (server restarted for deploy)$' "$log"
  expect "M3: only the run still going was sent to interrupt" grep -q '/interrupt auth=ok {"runs":\[{"itemId":"HZ-T2","kind":"resolve"}\]}' "$base/drain.log"
  interrupt_at="$(awk '/\/interrupt/ { print $1; exit }' "$base/drain.log")"
  expect "M3/M4: the interrupt happens before the restart" lt "$interrupt_at" "$(restart_ts "$base")"
  expect "M2: the deploy still ends DEPLOY OK" grep -q 'DEPLOY OK' "$log"
}

# ---- 3. G2: a wait of 0 interrupts before any poll, then restarts ----
{
  base="$(mktemp -d -p "$WORK")"
  setup_repo "$base"
  start_stub one "$base/drain.log" s3cret
  run_deploy "$base" "$url" FARM_SHARED_SECRET=s3cret HORIZON_DEPLOY_DRAIN_POLL_S=30 HORIZON_DEPLOY_DRAIN_TIMEOUT_S=0
  code=$?
  expect "G2 wait 0: deploy succeeds" [ "$code" -eq 0 ]
  expect "G2 wait 0: begin then interrupt, with no poll between" \
    [ "$(awk '{ printf "%s %s;", $2, ($3 ~ /interrupt/ ? "interrupt" : "drain") }' "$base/drain.log")" = "POST drain;POST interrupt;" ]
  interrupt_at="$(awk '/\/interrupt/ { print $1; exit }' "$base/drain.log")"
  expect "G2 wait 0: restart follows the interrupt" lt "$interrupt_at" "$(restart_ts "$base")"
}

# ---- 4. G2: a hung or down server never holds the deploy ----
for scenario in hang hang-interrupt down; do
  base="$(mktemp -d -p "$WORK")"
  setup_repo "$base"
  if [ "$scenario" = "down" ]; then
    # A port that was free a moment ago: nothing listens there.
    port="$(node -e 'const s = require("net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close() })')"
    url="http://127.0.0.1:$port/api/farm/deploy-drain"
  else
    start_stub "$scenario" "$base/drain.log" s3cret
  fi
  started=$SECONDS
  run_deploy "$base" "$url" FARM_SHARED_SECRET=s3cret HORIZON_DEPLOY_DRAIN_POLL_S=0.2 HORIZON_DEPLOY_DRAIN_TIMEOUT_S=1 \
    HORIZON_DEPLOY_DRAIN_REQUEST_TIMEOUT_S=1 HORIZON_DEPLOY_DRAIN_INTERRUPT_TIMEOUT_S=1
  code=$?
  took=$((SECONDS - started))
  expect "G2 $scenario: deploy succeeds" [ "$code" -eq 0 ]
  expect "G2 $scenario: logs DRAIN skipped" grep -q 'DRAIN skipped: ' "$base/state/self-deploy.log"
  expect "G2 $scenario: restart still runs" [ -n "$(restart_ts "$base")" ]
  expect "G2 $scenario: bounded by the wait plus the request timeouts (took ${took}s)" [ "$took" -lt 20 ]
  case "$scenario" in
    hang) reason='could not reach the server (no response within 1s)' ;;
    hang-interrupt) reason='interrupt failed (no response within 1s)' ;;
    down) reason='could not reach the server (ECONNREFUSED)' ;;
  esac
  expect "G2 $scenario: the skip says why: $reason" grep -qF "DRAIN skipped: $reason" "$base/state/self-deploy.log"
done

# ---- 5. M6: a deploy that fails before the restart completes lifts the block (ERR trap) ----
{
  base="$(mktemp -d -p "$WORK")"
  setup_repo "$base"
  start_stub one "$base/drain.log" s3cret
  run_deploy "$base" "$url" FARM_SHARED_SECRET=s3cret HORIZON_DEPLOY_DRAIN_TIMEOUT_S=0 SYSTEMCTL_FAIL_RESTART=1
  code=$?
  expect "M6: a failing restart fails the deploy" [ "$code" -ne 0 ]
  expect "M6: DEPLOY FAILED: restart is logged" grep -q 'DEPLOY FAILED: restart' "$base/state/self-deploy.log"
  expect "M6: the ERR trap sent DELETE to lift the block" grep -q ' DELETE /api/farm/deploy-drain auth=ok' "$base/drain.log"
  expect "M6: the release is logged" grep -q 'DRAIN released: new runs allowed again' "$base/state/self-deploy.log"
}

# ---- 6. G10: no secret ever reaches self-deploy.log, even when the server echoes headers ----
for scenario in echo500 mixed; do
  base="$(mktemp -d -p "$WORK")"
  setup_repo "$base"
  start_stub "$scenario" "$base/drain.log" sekrit-farm-HZ250
  run_deploy "$base" "$url" HORIZON_DEPLOY_DRAIN_POLL_S=0.2 HORIZON_DEPLOY_DRAIN_TIMEOUT_S=1 \
    FARM_SHARED_SECRET=sekrit-farm-HZ250 GITHUB_TOKEN=ghp-SENTINEL-HZ250 GITHUB_WEBHOOK_SECRET=whsec-SENTINEL-HZ250
  log="$base/state/self-deploy.log"
  expect "G10 $scenario: the drain ran" grep -q 'DRAIN ' "$log"
  for sentinel in sekrit-farm-HZ250 ghp-SENTINEL-HZ250 whsec-SENTINEL-HZ250; do
    expect "G10 $scenario: $sentinel never reaches self-deploy.log" bash -c "! grep -qF '$sentinel' '$log'"
  done
  if [ "$scenario" = "echo500" ]; then
    expect "G10 echo500: the skip names only the status" grep -qF 'DRAIN skipped: could not reach the server (HTTP 500)' "$log"
  fi
done

# ---- 7. no drain URL: no drain stage at all ----
{
  base="$(mktemp -d -p "$WORK")"
  setup_repo "$base"
  run_deploy "$base" ""
  code=$?
  expect "no drain URL: deploy succeeds" [ "$code" -eq 0 ]
  expect "no drain URL: nothing DRAIN is logged" bash -c "! grep -q 'DRAIN' '$base/state/self-deploy.log'"
}

echo "1..$((pass + fail))"
echo "# pass $pass"
echo "# fail $fail"
[ "$fail" -eq 0 ]
