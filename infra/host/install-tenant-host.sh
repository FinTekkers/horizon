#!/usr/bin/env bash
# HZ-697: installs what a tenant's self-serve repo connect needs on the host.
# Run once per change to these files, as root, from a checkout:
#
#   sudo bash infra/host/install-tenant-host.sh
#
#   1. checks horizon-tenant.sudoers with `visudo -cf` before anything else,
#      and (HZ-773) that the farm venv's python can import httpx,
#   2. creates the hz-tenants group every hz-p<id> run user gets,
#   3. installs horizon-provision-run-user root-owned, 0755, under
#      /usr/local/libexec/horizon/,
#   4. HZ-773: installs tenant-entry there too, root-owned, 0755, with the
#      farm venv's python on its shebang and the rest of the file unchanged —
#      left as it is when the installed copy already matches,
#   5. creates /etc/horizon/tenant-tokens owned by the farm user, mode 0700 —
#      the server writes each tenant's token there, 0600, as that user,
#   6. installs the sudoers rules (the helper's, and tenant-entry run as any
#      member of hz-tenants) to /etc/sudoers.d/horizon-tenant, 0440, and checks
#      the whole sudoers tree with `visudo -c` (removing it again on failure).
# Any failure stops the script; a sudoers file that fails visudo is never
# installed. Safe to re-run.
#
# Env: HORIZON_FARM_USER    the user both services run as (default ubuntu).
#      HORIZON_FARM_PYTHON  the farm venv's interpreter, as in
#                           horizon-farm.service's ExecStart (default
#                           /opt/horizon/farm/.venv/bin/python).
#      HORIZON_LIBEXEC      where the helper and tenant-entry go (default
#                           /usr/local/libexec/horizon) — for the tests only:
#                           the sudoers rules name the default path.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FARM_USER="${HORIZON_FARM_USER:-ubuntu}"
FARM_PY="${HORIZON_FARM_PYTHON:-/opt/horizon/farm/.venv/bin/python}"
LIBEXEC="${HORIZON_LIBEXEC:-/usr/local/libexec/horizon}"
TOKEN_DIR=/etc/horizon/tenant-tokens
SUDOERS_DEST=/etc/sudoers.d/horizon-tenant

fail() {
  echo "install-tenant-host: ERROR $1" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || fail "must run as root"
visudo -cf "$HERE/horizon-tenant.sudoers" >/dev/null || fail "horizon-tenant.sudoers does not parse"
# Without httpx every tenant step dies on its first import (HZ-773).
[ -x "$FARM_PY" ] && "$FARM_PY" -c 'import httpx' >/dev/null 2>&1 || fail "$FARM_PY cannot import httpx — is the farm venv installed?"
groupadd -f hz-tenants
install -d -o root -g root -m 0755 "$LIBEXEC"
install -o root -g root -m 0755 "$HERE/horizon-provision-run-user" "$LIBEXEC/horizon-provision-run-user"

# tenant-entry: the repo's file with line 1 swapped for the venv's shebang.
staged="$(mktemp)"
trap 'rm -f "$staged"' EXIT
{
  printf '#!%s\n' "$FARM_PY"
  tail -n +2 "$HERE/tenant-entry"
} >"$staged"
dest="$LIBEXEC/tenant-entry"
if [ -f "$dest" ] && [ ! -L "$dest" ] && cmp -s "$staged" "$dest" && [ "$(stat -c '%u:%g %a' "$dest")" = "0:0 755" ]; then
  echo "install-tenant-host: tenant-entry already current"
else
  install -o root -g root -m 0755 "$staged" "$dest"
fi

install -d -o "$FARM_USER" -g "$FARM_USER" -m 0700 "$TOKEN_DIR"
install -o root -g root -m 0440 "$HERE/horizon-tenant.sudoers" "$SUDOERS_DEST"
if ! visudo -c >/dev/null; then
  rm -f "$SUDOERS_DEST"
  fail "sudoers did not parse with horizon-tenant installed — removed it again"
fi
echo "install-tenant-host: ok"
