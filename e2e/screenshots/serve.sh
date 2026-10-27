#!/usr/bin/env bash
# HZ-512: `serve` for Horizon's own .horizon/screenshots.json. The farm's
# capture runner (farm/screenshot_runner.py) starts this in its own process
# group, polls `ready` (the UI port below), captures, then SIGTERMs the group.
#
# 1. Builds the UI at the root path, as the e2e suite does.
# 2. Seeds a throwaway DB (e2e/screenshots/seed.mjs): the orchestrator-proof
#    rows before the server boots, the rest once it answers.
# 3. Runs the server in demo mode with HORIZON_TEST_HOOKS=1, so a `login: true`
#    shot's SCREENSHOT_LOGIN_KEY header (HZ-511, testEnvLogin.js) logs it in.
#    The runner puts that key in this script's env.
# 4. Serves the built UI with vite preview, proxying /api to the server.
#
# The ports are fixed because `ready` is a literal in the config. They sit
# above both of the e2e suite's port windows (3057-4056, 4351-5350), and a
# host-wide lock lets one capture at a time hold them: a second item's
# capture waits for the first instead of reaching its server.
#
# The lock and the port sweep come first, before the build: the runner polls
# `ready` from the moment this starts, so a leftover UI still on UI_PORT would
# pass it and every shot would hit that leftover instead. The lock file is a
# fixed path, not under TMPDIR, so it is host-wide even when TMPDIR is per item.
# No child holds the lock's fd (9>&-), so a leftover child can never keep it,
# and on exit this script stops its own children.
set -euo pipefail

UI_PORT=5480
SERVER_PORT=5481
LOCK_WAIT_S=90
LOCK_FILE=/tmp/horizon-screenshots-serve.lock

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/horizon-screens-XXXXXX")"
DB="$TMP/horizon.db"
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$TMP"' EXIT
trap 'exit 143' TERM INT

exec 9>"$LOCK_FILE"
if ! flock -w "$LOCK_WAIT_S" 9; then
  echo "serve: another screenshot capture held the ports for ${LOCK_WAIT_S}s" >&2
  exit 1
fi
# Holding the lock, anything still on these ports is a leftover of ours.
fuser -k "$UI_PORT/tcp" "$SERVER_PORT/tcp" >/dev/null 2>&1 || true
for _ in $(seq 50); do
  fuser "$UI_PORT/tcp" "$SERVER_PORT/tcp" >/dev/null 2>&1 || break
  sleep 0.1
done
if fuser "$UI_PORT/tcp" "$SERVER_PORT/tcp" >/dev/null 2>&1; then
  echo "serve: ports $UI_PORT/$SERVER_PORT are held by a process this user cannot stop" >&2
  exit 1
fi

for dir in server ui e2e; do
  [ -d "$ROOT/$dir/node_modules" ] || npm --prefix "$ROOT/$dir" ci --no-audit --no-fund 9>&-
done

(cd "$ROOT/ui" && env -u HORIZON_BASE -u HORIZON_E2E_COVERAGE_DIR npm run build) 9>&-

node "$ROOT/e2e/screenshots/seed.mjs" before "$DB" 9>&-

# Demo mode, as e2e/playwright.config.js runs it: no GitHub, no farm, no
# messages, and no login credential inherited from the host. HOME is empty
# too, so Admin's deploy targets never show this host's ~/.horizon state.
mkdir -p "$TMP/home"
(
  cd "$ROOT/server"
  exec env -u ADMIN_EMAIL -u ADMIN_PASSWORD -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET -u ALLOWED_LOGIN_EMAILS \
    HOME="$TMP/home" HORIZON_DB="$DB" PORT="$SERVER_PORT" HORIZON_UI_URL="http://127.0.0.1:$UI_PORT" MOCK_STEP_LATENCY_MS=50 \
    HORIZON_REPO= GITHUB_TOKEN= GITHUB_WEBHOOK_SECRET= FARM_URL= FARM_HOME="$TMP/farm-home" \
    WA_NOTIFY_ENABLED=0 WA_BRIDGE_URL=http://127.0.0.1:9 HORIZON_TEST_HOOKS=1 \
    RULES_HMAC_SECRET=screens-rules-hmac-secret FARM_SHARED_SECRET=screens-farm-secret \
    node src/server.js
) 9>&- &
server=$!

until curl -sf -o /dev/null "http://127.0.0.1:$SERVER_PORT/api/health"; do
  kill -0 "$server" 2>/dev/null || { echo "serve: the server exited before it answered" >&2; exit 1; }
  sleep 0.2
done

node "$ROOT/e2e/screenshots/seed.mjs" after "$DB" "http://127.0.0.1:$SERVER_PORT" 9>&-

(
  cd "$ROOT/ui"
  exec env VITE_PROXY_TARGET="http://127.0.0.1:$SERVER_PORT" \
    ./node_modules/.bin/vite preview --host 127.0.0.1 --port "$UI_PORT" --strictPort
) 9>&- &

wait -n
echo "serve: the server or the UI exited" >&2
exit 1
