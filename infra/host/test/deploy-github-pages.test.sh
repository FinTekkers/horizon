#!/usr/bin/env bash
# Behavioral test harness for infra/host/deploy-github-pages.sh, and the
# values its deploy-parvati-site.sh wrapper sets. A local HTTP server stands in for GitHub's
# API and the published site: each case writes the JSON files the script
# reads (the server ignores query strings). sudo, systemctl, git and npm are
# PATH stubs that log any call: a Pages deploy must never run any of them.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR="$(cd "$HERE/.." && pwd)"
WORK="$(mktemp -d)"
STUBS="$WORK/stubs"
mkdir -p "$STUBS"
SERVER_PID=""
trap '[ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$WORK"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }
not_ok() { fail=$((fail + 1)); echo "not ok - $1"; }
expect() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else not_ok "$name"; fi; }

for cmd in sudo systemctl git npm; do
  printf '#!/usr/bin/env bash\necho "%s $*" >>"${FORBIDDEN_LOG:?}"\nexit 1\n' "$cmd" >"$STUBS/$cmd"
  chmod +x "$STUBS/$cmd"
done

ROOT="$WORK/www"
mkdir -p "$WORK/tmp"
API_DIR="$ROOT/repos/ParvatiRealEstate/parvati-site"
mkdir -p "$API_DIR/commits" "$API_DIR/deployments/1" "$API_DIR/deployments/2" "$API_DIR/compare" "$ROOT/site"
echo '<h1>Parvati</h1>' >"$ROOT/site/index.html"
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
# Serves $ROOT and appends each request's Authorization header (or "none")
# to $WORK/auth.log.
(cd "$ROOT" && exec python3 -c '
import http.server, sys
class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        with open(sys.argv[2], "a") as f:
            f.write((self.headers.get("Authorization") or "none") + "\n")
        super().do_GET()
    def log_message(self, *a):
        pass
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
' "$PORT" "$WORK/auth.log") >/dev/null 2>&1 &
SERVER_PID=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$PORT/site/" >/dev/null 2>&1 && break; sleep 0.1; done

TAG_SHA=aaaa000000000000000000000000000000000001
LATER_SHA=bbbb000000000000000000000000000000000002
echo "{\"sha\": \"$TAG_SHA\"}" >"$API_DIR/commits/release-1"

# Runs the shared script against the stub with a fresh state dir. The
# wrapper's own values are checked once, at the end.
run() {
  STATE="$(mktemp -d "$WORK/state.XXXX")"
  FORBIDDEN_LOG="$WORK/forbidden.log" PATH="$STUBS:$PATH" \
    DEPLOY_NAME=parvati-site DEPLOY_PAGES_REPO=ParvatiRealEstate/parvati-site \
    DEPLOY_PAGES_URL="http://127.0.0.1:$PORT/site/" \
    HORIZON_GITHUB_API="http://127.0.0.1:$PORT" HORIZON_STATE_DIR="$STATE" \
    HORIZON_PAGES_WAIT_S=0 HORIZON_PAGES_POLL_S=0 DEPLOY_PAGES_TOKEN_FILE="${TOKEN_FILE:-}" \
    TMPDIR="$WORK/tmp" \
    bash "$HOST_DIR/deploy-github-pages.sh" "$1" >/dev/null 2>&1
  echo "exit=$?" >>"$STATE/self-deploy.log"
}

# 1. The newest deployment is the tag's commit and succeeded: DEPLOY OK.
echo "[{\"id\": 1, \"sha\": \"$TAG_SHA\"}]" >"$API_DIR/deployments/index.html"
echo '[{"state": "success"}]' >"$API_DIR/deployments/1/statuses"
run release-1
expect "live at the tag's commit: DEPLOY OK names the tag and commit" grep -q "DEPLOY OK tag=refs/tags/release-1 commit=$TAG_SHA" "$STATE/self-deploy.log"
expect "live at the tag's commit: exit 0" grep -qx 'exit=0' "$STATE/self-deploy.log"
expect "live at the tag's commit: last-good-tag names the tag and commit" grep -qx "refs/tags/release-1:$TAG_SHA" "$STATE/last-good-tag"

# 2. A later commit on main is live (compare says ahead): DEPLOY OK.
echo "[{\"id\": 2, \"sha\": \"$LATER_SHA\"}]" >"$API_DIR/deployments/index.html"
echo '[{"state": "success"}]' >"$API_DIR/deployments/2/statuses"
echo '{"status": "ahead"}' >"$API_DIR/compare/$TAG_SHA...$LATER_SHA"
run release-1
expect "a later live commit holds the tag: DEPLOY OK" grep -q "DEPLOY OK tag=refs/tags/release-1" "$STATE/self-deploy.log"

# 3. The newest deployment is still in progress and the wait runs out.
echo "[{\"id\": 1, \"sha\": \"$TAG_SHA\"}]" >"$API_DIR/deployments/index.html"
echo '[{"state": "in_progress"}]' >"$API_DIR/deployments/1/statuses"
run release-1
expect "no successful deployment in time: DEPLOY FAILED: pages is the last line" bash -c "[ \"\$(grep -v '^exit=' '$STATE/self-deploy.log' | tail -1 | cut -d' ' -f2-)\" = 'DEPLOY FAILED: pages (tag=release-1)' ]"
expect "no successful deployment in time: exit non-zero" bash -c "! grep -qx 'exit=0' '$STATE/self-deploy.log'"
expect "no successful deployment in time: no last-good-tag" test ! -e "$STATE/last-good-tag"

# 4. An unknown tag fails at once.
run no-such-tag
expect "unknown tag: DEPLOY FAILED: tag" grep -q 'DEPLOY FAILED: tag (tag=no-such-tag)' "$STATE/self-deploy.log"

# 5. The site is down: DEPLOY FAILED: site.
echo '[{"state": "success"}]' >"$API_DIR/deployments/1/statuses"
mv "$ROOT/site" "$ROOT/site-down"
run release-1
expect "site not served: DEPLOY FAILED: site" grep -q 'DEPLOY FAILED: site (tag=release-1)' "$STATE/self-deploy.log"
mv "$ROOT/site-down" "$ROOT/site"

# 6. A readable token file: every API call carries it as a header; it is in
# no log line and its temp header file is gone afterwards.
echo '[{"state": "success"}]' >"$API_DIR/deployments/1/statuses"
echo "[{\"id\": 1, \"sha\": \"$TAG_SHA\"}]" >"$API_DIR/deployments/index.html"
printf 'tok_SECRET_123\n' >"$WORK/token"
: >"$WORK/auth.log"
TOKEN_FILE="$WORK/token" run release-1
expect "token file: DEPLOY OK" grep -q "DEPLOY OK tag=refs/tags/release-1" "$STATE/self-deploy.log"
expect "token file: every API call sends it" bash -c "grep -v '^none$' '$WORK/auth.log' | grep -q 'Bearer tok_SECRET_123' && ! grep -q '^none$' <(head -3 '$WORK/auth.log')"
expect "token file: the token is in no log line" bash -c "! grep -q tok_SECRET_123 '$STATE/self-deploy.log'"
expect "token file: no temp header file is left" bash -c "[ -z \"\$(ls -A '$WORK/tmp')\" ]"

# 7. No token file: no Authorization header at all.
: >"$WORK/auth.log"
run release-1
expect "no token file: no Authorization header" bash -c "! grep -q Bearer '$WORK/auth.log'"

expect "the wrapper names parvati-site's repo, site and state dir" bash -c "grep -qx 'export DEPLOY_PAGES_REPO=ParvatiRealEstate/parvati-site' '$HOST_DIR/deploy-parvati-site.sh' && grep -qx 'export DEPLOY_PAGES_URL=https://parvatirealestate.github.io/parvati-site/' '$HOST_DIR/deploy-parvati-site.sh' && grep -qx 'export DEPLOY_NAME=parvati-site' '$HOST_DIR/deploy-parvati-site.sh'"
expect "nothing called sudo, systemctl, git or npm" bash -c "[ ! -s '$WORK/forbidden.log' ]"

echo "# deploy-github-pages: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
