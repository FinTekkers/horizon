#!/usr/bin/env bash
# Behavioral test harness for infra/host/deploy-publish-release.sh through its
# deploy-ledger-models.sh wrapper. git runs for real against a throwaway
# upstream (the version tag push is the thing under test); curl is a stub
# that answers the GitHub Actions runs API from a fixture file.
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

# Prints $RUNS_FILE (the Actions API reply) and logs the URL it was asked for.
cat >"$STUBS/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${*: -1}" >>"${CURL_LOG:-/dev/null}"
cat "${RUNS_FILE:?}"
EOF
chmod +x "$STUBS/curl"

# runs_json WORKFLOW:STATUS:CONCLUSION ... — one run per argument.
runs_json() {
  python3 - "$@" <<'EOF'
import json, sys
runs = []
for spec in sys.argv[1:]:
    path, status, conclusion = spec.split(":")
    runs.append({"path": ".github/workflows/" + path, "status": status, "conclusion": conclusion or None})
print(json.dumps({"workflow_runs": runs}))
EOF
}

REQUIRED="cargo-publish.yml pypi-publish.yml npm-publish.yml npmjs-publish.yml maven-publish.yml"
all_required() { for w in $REQUIRED; do printf '%s:completed:success ' "$w"; done; }

setup_repo() {
  # setup_repo BASE — upstream with v0.4.12 on main, then one more commit
  # tagged as Horizon's release (deploy-lm-1); a clone to deploy from.
  local base="$1"
  git init --quiet --bare --initial-branch=main "$base/upstream.git"
  git clone --quiet "$base/upstream.git" "$base/seed" 2>/dev/null
  (
    cd "$base/seed" || exit 1
    git checkout --quiet -b main
    git config user.email test@example.com
    git config user.name "Deploy Test"
    echo one >file && git add -A && git commit --quiet -m one && git tag v0.4.12
    echo two >file && git add -A && git commit --quiet -m two && git tag deploy-lm-1
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
    HORIZON_GITHUB_TOKEN=test-token \
    HORIZON_GITHUB_API=http://stub.invalid \
    HORIZON_PUBLISH_TIMEOUT_S=1 \
    HORIZON_PUBLISH_POLL_S=0.2 \
    HORIZON_DEPLOY_LOCK_TIMEOUT_S=5 \
    RUNS_FILE="$base/runs.json" CURL_LOG="$base/curl.log" \
    "$@" \
    "$HOST_DIR/deploy-ledger-models.sh" "$tag" >/dev/null 2>&1
}

new_base() {
  local base
  base="$(mktemp -d "$WORK/run.XXXX")"
  mkdir -p "$base/home"
  setup_repo "$base"
  echo "$base"
}

upstream_tag() { git -C "$1/upstream.git" rev-parse -q --verify "refs/tags/$2^{commit}"; }

# ---- 1. the release commit gets the next patch version; publishing passes ----
{
  base="$(new_base)"
  # shellcheck disable=SC2046
  runs_json $(all_required) maven-central.yml:in_progress: >"$base/runs.json"
  run_deploy "$base" deploy-lm-1
  code=$?
  sha="$(git -C "$base/seed" rev-parse deploy-lm-1)"
  expect "ok: exits 0" test "$code" -eq 0
  expect "ok: pushes v0.4.13 on the release commit" test "$(upstream_tag "$base" v0.4.13)" = "$sha"
  expect "ok: asks the Actions API about v0.4.13 pushes" grep -q "repos/FinTekkers/ledger-models/actions/runs?event=push&branch=v0.4.13" "$base/curl.log"
  expect "ok: logs DEPLOY OK with the version" grep -q "DEPLOY OK tag=refs/tags/deploy-lm-1 commit=$sha version=v0.4.13" "$base/state/self-deploy.log"
  expect "ok: records last-good-tag" grep -qx "refs/tags/deploy-lm-1:$sha" "$base/state/last-good-tag"

  # ---- 2. a rerun reuses the version the commit already has ----
  run_deploy "$base" deploy-lm-1
  code=$?
  expect "rerun: exits 0" test "$code" -eq 0
  expect "rerun: does not push v0.4.14" test -z "$(upstream_tag "$base" v0.4.14)"
  expect "rerun: logs the reused version" grep -q "already carries v0.4.13" "$base/state/self-deploy.log"
}

# ---- 3. a failed publish workflow fails the deploy ----
{
  base="$(new_base)"
  # shellcheck disable=SC2046
  runs_json $(all_required | sed 's/cargo-publish.yml:completed:success/cargo-publish.yml:completed:failure/') maven-central.yml:in_progress: >"$base/runs.json"
  run_deploy "$base" deploy-lm-1
  code=$?
  expect "required failure: exits non-zero" test "$code" -ne 0
  expect "required failure: names the workflow" grep -q "DEPLOY FAILED: publish .*v0.4.13: cargo-publish.yml concluded failure" "$base/state/self-deploy.log"
  expect "required failure: no last-good-tag" test ! -e "$base/state/last-good-tag"
}

# ---- 4. Maven Central may still be running, but not failed ----
{
  base="$(new_base)"
  # shellcheck disable=SC2046
  runs_json $(all_required) maven-central.yml:completed:failure >"$base/runs.json"
  run_deploy "$base" deploy-lm-1
  code=$?
  expect "started-workflow failure: exits non-zero" test "$code" -ne 0
  expect "started-workflow failure: names maven-central.yml" grep -q "maven-central.yml concluded failure" "$base/state/self-deploy.log"
}

# ---- 5. workflows that never finish time out ----
{
  base="$(new_base)"
  runs_json cargo-publish.yml:queued: >"$base/runs.json"
  run_deploy "$base" deploy-lm-1
  code=$?
  expect "timeout: exits non-zero" test "$code" -ne 0
  expect "timeout: says what it was waiting for" grep -q "DEPLOY FAILED: publish .*after 1s: cargo-publish.yml queued, pypi-publish.yml not started" "$base/state/self-deploy.log"
}

# ---- 6. an unknown release tag publishes nothing ----
{
  base="$(new_base)"
  runs_json >"$base/runs.json"
  run_deploy "$base" no-such-tag
  code=$?
  expect "unknown tag: exits non-zero" test "$code" -ne 0
  expect "unknown tag: logs DEPLOY FAILED: resolve" grep -q "DEPLOY FAILED: resolve (tag=no-such-tag)" "$base/state/self-deploy.log"
  expect "unknown tag: pushes no version tag" test -z "$(upstream_tag "$base" v0.4.13)"
}

echo "# deploy-publish-release: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
