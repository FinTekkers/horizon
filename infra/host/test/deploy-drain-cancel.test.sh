#!/usr/bin/env bash
# HZ-256: a deploy's drain stops a running resolve's resolver in farmd BEFORE
# it restarts horizon-server. End to end through the real deploy-horizon.sh
# and the real deploy-drain.mjs, against the REAL server code (buildApp from
# server/src/app.js, a throwaway DB holding one running resolve row), with a
# stub farmd that records POST /conflicts/cancel with a timestamp. The stub
# systemctl records its timestamps too (same stubs as deploy-drain.test.sh),
# so the test proves farmd heard the cancel before `restart` ran.
#
# Its own file so deploy-drain.test.sh stays unedited. Wired into the root
# `npm test`, after `npm --prefix server install`.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HORIZON_DEPLOY_SH="$HERE/../deploy-horizon.sh"
SERVER_SRC="$(cd "$HERE/../../../server/src" && pwd)"
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
lt() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a < b) }'; }

cat >"$STUBS/sudo" <<'EOF'
#!/usr/bin/env bash
exec "$@"
EOF

cat >"$STUBS/systemctl" <<'EOF'
#!/usr/bin/env bash
printf '%s %s\n' "$(date +%s.%N)" "$*" >>"${SYSTEMCTL_LOG:-/dev/null}"
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

# One node process: a stub farmd, then the real server app pointed at it.
cat >"$WORK/server.mjs" <<'EOF'
import http from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [serverSrc, farmLog, portFile, work] = process.argv.slice(2)
const farm = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    appendFileSync(farmLog, `${(Date.now() / 1000).toFixed(3)} ${req.method} ${req.url} ${body}\n`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, cancelled: true, killed: 2, lock_released: true }))
  })
})
await new Promise((resolve) => farm.listen(0, '127.0.0.1', resolve))
process.env.FARM_URL = `http://127.0.0.1:${farm.address().port}`
process.env.HORIZON_DB = join(work, 'horizon.db')
process.env.HOME = work
const { db } = await import(join(serverSrc, 'db.js'))
const store = await import(join(serverSrc, 'store.js'))
const { buildApp } = await import(join(serverSrc, 'app.js'))
store.purgeDemoItems()
db.prepare("INSERT INTO work_item (id, title, priority, cursor, repo, pr, pr_mergeable) VALUES ('HZ-R1', 'Mid-resolve', 'Medium', 10, 'acme/demo', 7, 0)").run()
store.claimGateAction('HZ-R1', 'resolve', { detail: 'resolving', timeoutMs: 600_000 })
const app = buildApp({ logger: false })
await app.listen({ port: 0, host: '127.0.0.1' })
writeFileSync(portFile, String(app.server.address().port))
EOF

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
    git add -A
    git commit --quiet -m v1
    git tag v1
    git push --quiet origin main
    git push --quiet origin --tags
  )
  git clone --quiet "$base/upstream.git" "$base/repo" 2>/dev/null
}

base="$(mktemp -d -p "$WORK")"
setup_repo "$base"
port_file="$base/port"
FARM_SHARED_SECRET=s3cret-HZ256 GITHUB_TOKEN=ghp-SENTINEL-HZ256 GITHUB_WEBHOOK_SECRET=whsec-SENTINEL-HZ256 \
  node "$WORK/server.mjs" "$SERVER_SRC" "$base/farm.log" "$port_file" "$base" >"$base/server.out" 2>&1 &
STUB_PIDS+=("$!")
for _ in $(seq 1 400); do [ -s "$port_file" ] && break; sleep 0.05; done
expect "the real server came up" [ -s "$port_file" ]

env PATH="$STUBS:$PATH" \
  HORIZON_REPO_DIR="$base/repo" \
  HORIZON_STATE_DIR="$base/state" \
  HORIZON_SERVICE_NAME="horizon-server-test" \
  HORIZON_HEALTH_URL="http://stub.invalid/api/health" \
  HORIZON_HEALTH_TIMEOUT_S="5" \
  HORIZON_HEALTH_POLL_S="0.05" \
  HORIZON_DEPLOY_LOCK_TIMEOUT_S="10" \
  HORIZON_DEPLOY_DRAIN_URL="http://127.0.0.1:$(cat "$port_file" 2>/dev/null)/api/farm/deploy-drain" \
  HORIZON_DEPLOY_DRAIN_TIMEOUT_S="0" \
  FARM_SHARED_SECRET=s3cret-HZ256 \
  GITHUB_TOKEN=ghp-SENTINEL-HZ256 \
  GITHUB_WEBHOOK_SECRET=whsec-SENTINEL-HZ256 \
  SYSTEMCTL_LOG="$base/systemctl.log" \
  "$HORIZON_DEPLOY_SH" v1 >>"$base/deploy.out" 2>&1
code=$?

log="$base/state/self-deploy.log"
cancel_at="$(awk '$3 == "/conflicts/cancel" { print $1; exit }' "$base/farm.log" 2>/dev/null)"
restart_at="$(awk '$2 == "restart" && $3 == "horizon-server-test" { print $1; exit }' "$base/systemctl.log" 2>/dev/null)"
expect "the deploy succeeds" [ "$code" -eq 0 ]
expect "farmd got exactly one cancel" [ "$(grep -c ' /conflicts/cancel ' "$base/farm.log" 2>/dev/null)" = 1 ]
expect "the cancel names the item and its repo" grep -qF 'POST /conflicts/cancel {"item":"HZ-R1","repo":"acme/demo"}' "$base/farm.log"
expect "the cancel reached farmd before the restart ($cancel_at < $restart_at)" lt "${cancel_at:-9e99}" "${restart_at:-0}"
expect "the drain logged the resolve as interrupted" grep -q 'HZ-R1 resolve' "$log"
for sentinel in s3cret-HZ256 ghp-SENTINEL-HZ256 whsec-SENTINEL-HZ256; do
  expect "$sentinel never reaches self-deploy.log or farmd" bash -c "! grep -qF '$sentinel' '$log' '$base/farm.log'"
done

echo "1..$((pass + fail))"
echo "# pass $pass"
echo "# fail $fail"
[ "$fail" -eq 0 ]
