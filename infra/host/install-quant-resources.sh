#!/usr/bin/env bash
# HZ-972: set up FinTekkers' quant resource store on this host — a checkout of
# the private repo FinTekkers/quant-library (pinned libraries as submodules,
# papers, venv lock and its own sync.sh) at /opt/quant-resources.
#
# Run as the farm user, after root has created the directory once and given it
# to the farm user (`sudo install -d -o <farm user> -m 0750 /opt/quant-resources`):
#
#   infra/host/install-quant-resources.sh
#
# Idempotent:
#   1. Clones the repo (blob-less) when the directory has no checkout yet.
#   2. Checks out the commit farm/projects/fintekkers/quant_resources.json
#      pins as store.sha, fetching only when that commit is not there yet.
#   3. Runs the repo's own ./sync.sh, which leaves pinned libraries and a venv
#      matching its lock untouched.
#   4. Makes libs/ and venv/ read-only, and the whole store unreadable to
#      other users: several papers are publisher versions, and other projects'
#      run users must not read them.
# A second run changes nothing. Bumping the pin is a registry PR, then a re-run.
#
# Overridable for tests: HORIZON_QUANT_RESOURCES_DIR (the store),
# QUANT_LIBRARY_URL (the repo) and QUANT_RESOURCES_REGISTRY (the registry).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DIR="${HORIZON_QUANT_RESOURCES_DIR:-/opt/quant-resources}"
URL="${QUANT_LIBRARY_URL:-https://github.com/FinTekkers/quant-library.git}"
REGISTRY="${QUANT_RESOURCES_REGISTRY:-$ROOT/farm/projects/fintekkers/quant_resources.json}"

log() { printf 'install-quant-resources: %s\n' "$*"; }
die() { log "$*" >&2; exit 1; }

SHA="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["store"]["sha"])' "$REGISTRY")" \
  || die "cannot read store.sha from $REGISTRY"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "store.sha in $REGISTRY is not a 40-hex commit"

if [ ! -d "$DIR/.git" ]; then
  log "cloning $URL into $DIR"
  git clone --quiet --filter=blob:none "$URL" "$DIR"
fi

# A previous run left libs/ and venv/ read-only: unlock them for the checkout
# (a new pin can add a library) and for sync.sh.
for sub in libs venv; do
  if [ -d "$DIR/$sub" ]; then chmod -R u+w "$DIR/$sub"; fi
done

if [ "$(git -C "$DIR" rev-parse HEAD)" != "$SHA" ]; then
  git -C "$DIR" cat-file -e "$SHA^{commit}" 2>/dev/null || git -C "$DIR" fetch --quiet origin
  log "checking out ${SHA:0:12}"
  git -C "$DIR" -c advice.detachedHead=false checkout --quiet "$SHA"
fi

(cd "$DIR" && ./sync.sh)

chmod o-rwx "$DIR"
for sub in libs venv; do
  if [ -d "$DIR/$sub" ]; then chmod -R a-w,o-rwx "$DIR/$sub"; fi
done
log "store at ${SHA:0:12}: $DIR"
