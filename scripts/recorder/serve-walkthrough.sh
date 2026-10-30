#!/usr/bin/env bash
# HZ-665: the throwaway Horizon that `--walkthrough` scenarios are filmed
# against (scripts/recorder/README.md has the steps). It starts on an empty
# board, so chapter 1 (setup.json) looks like a first run.
#
# The env block below mirrors e2e/screenshots/serve.sh's demo mode: no
# GitHub, no farm, no messages, no login credential from the host. A change
# to that block probably belongs in both scripts. Unlike serve.sh this script:
#   - uses its own ports (5490/5491, outside both e2e windows and serve.sh's
#     5480/5481) and takes no lock, so it never blocks a farm capture;
#   - never stops another process: a busy port is an error;
#   - always uses a fresh mktemp DB, removed on exit, and seeds nothing.
#
# The board logs the recorder in with SCREENSHOT_LOGIN_KEY (HORIZON_TEST_HOOKS=1,
# server/src/testEnvLogin.js). Export a fresh random key in both terminals; it
# is never printed.
set -euo pipefail

if [ -z "${SCREENSHOT_LOGIN_KEY:-}" ]; then
  echo 'serve-walkthrough: export SCREENSHOT_LOGIN_KEY first, e.g. export SCREENSHOT_LOGIN_KEY=$(openssl rand -hex 16)' >&2
  exit 1
fi

UI_PORT="${WALKTHROUGH_UI_PORT:-5490}"
SERVER_PORT="${WALKTHROUGH_SERVER_PORT:-5491}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

for port in "$UI_PORT" "$SERVER_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "serve-walkthrough: port $port is in use; stop what holds it, or set WALKTHROUGH_UI_PORT / WALKTHROUGH_SERVER_PORT" >&2
    exit 1
  fi
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/horizon-walkthrough-XXXXXX")"
DB="$TMP/horizon.db"
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$TMP"' EXIT
trap 'exit 143' TERM INT

for dir in server ui; do
  [ -d "$ROOT/$dir/node_modules" ] || npm --prefix "$ROOT/$dir" ci --no-audit --no-fund
done

(cd "$ROOT/ui" && env -u HORIZON_BASE -u HORIZON_E2E_COVERAGE_DIR -u VITE_PROXY_TARGET node scripts/ensure-build.mjs)

mkdir -p "$TMP/home"
(
  cd "$ROOT/server"
  exec env -u ADMIN_EMAIL -u ADMIN_PASSWORD -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET -u ALLOWED_LOGIN_EMAILS \
    HOME="$TMP/home" HORIZON_DB="$DB" PORT="$SERVER_PORT" HORIZON_UI_URL="http://127.0.0.1:$UI_PORT" MOCK_STEP_LATENCY_MS=50 \
    HORIZON_REPO= GITHUB_TOKEN= GITHUB_WEBHOOK_SECRET= FARM_URL= FARM_HOME="$TMP/farm-home" \
    WA_NOTIFY_ENABLED=0 WA_BRIDGE_URL=http://127.0.0.1:9 HORIZON_TEST_HOOKS=1 \
    RULES_HMAC_SECRET=walkthrough-rules-hmac-secret FARM_SHARED_SECRET=walkthrough-farm-secret \
    node src/server.js
) &
server=$!

until curl -sf -o /dev/null "http://127.0.0.1:$SERVER_PORT/api/health"; do
  kill -0 "$server" 2>/dev/null || { echo "serve-walkthrough: the server exited before it answered" >&2; exit 1; }
  sleep 0.2
done

# The board starts empty. The server's db.js seeds the BF-* demo items into an
# empty work_item table on every boot, so they are removed once it has booted,
# with the same deletes as store.js purgeDemoItems(). They all sit at gates, so
# no agent step is running on them. The server reads items from the DB on each
# request, and no browser has loaded the board yet.
(cd "$ROOT/server" && HORIZON_DB="$DB" node --input-type=module -e "
import Database from 'better-sqlite3'
const db = new Database(process.env.HORIZON_DB)
db.pragma('foreign_keys = ON')
db.transaction(() => {
  for (const table of ['event', 'gate_decision', 'feedback', 'step_run']) db.prepare(\`DELETE FROM \${table} WHERE item_id LIKE 'BF-%'\`).run()
  db.prepare(\"DELETE FROM work_item WHERE id LIKE 'BF-%'\").run()
})()
db.close()
")

(
  cd "$ROOT/ui"
  exec env VITE_PROXY_TARGET="http://127.0.0.1:$SERVER_PORT" \
    ./node_modules/.bin/vite preview --host 127.0.0.1 --port "$UI_PORT" --strictPort
) &
ui=$!

until curl -sf -o /dev/null "http://127.0.0.1:$UI_PORT/"; do
  kill -0 "$ui" 2>/dev/null || { echo "serve-walkthrough: the UI exited before it answered" >&2; exit 1; }
  sleep 0.2
done
echo "walkthrough board ready: http://127.0.0.1:$UI_PORT (Ctrl-C stops it and deletes its DB)"

wait -n
echo "serve-walkthrough: the server or the UI exited" >&2
exit 1
