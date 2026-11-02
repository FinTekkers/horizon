#!/usr/bin/env bash
# HZ-697: installs what a tenant's self-serve repo connect needs on the host.
# Run once per change to these files, as root, from a checkout:
#
#   sudo bash infra/host/install-tenant-host.sh
#
#   1. checks horizon-tenant.sudoers with `visudo -cf` before anything else,
#   2. creates the hz-tenants group every hz-p<id> run user gets,
#   3. installs horizon-provision-run-user root-owned, 0755, under
#      /usr/local/libexec/horizon/,
#   4. creates /etc/horizon/tenant-tokens owned by the farm user, mode 0700 —
#      the server writes each tenant's token there, 0600, as that user,
#   5. installs the sudoers rules (the helper's, and tenant-entry run as any
#      member of hz-tenants) to /etc/sudoers.d/horizon-tenant, 0440, and checks
#      the whole sudoers tree with `visudo -c` (removing it again on failure).
# Any failure stops the script; a sudoers file that fails visudo is never
# installed. tenant-entry itself is installed as in DEPLOY.md (HZ-663).
#
# Env: HORIZON_FARM_USER  the user both services run as (default ubuntu).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FARM_USER="${HORIZON_FARM_USER:-ubuntu}"
LIBEXEC=/usr/local/libexec/horizon
TOKEN_DIR=/etc/horizon/tenant-tokens
SUDOERS_DEST=/etc/sudoers.d/horizon-tenant

fail() {
  echo "install-tenant-host: ERROR $1" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || fail "must run as root"
visudo -cf "$HERE/horizon-tenant.sudoers" >/dev/null || fail "horizon-tenant.sudoers does not parse"
groupadd -f hz-tenants
install -d -o root -g root -m 0755 "$LIBEXEC"
install -o root -g root -m 0755 "$HERE/horizon-provision-run-user" "$LIBEXEC/horizon-provision-run-user"
install -d -o "$FARM_USER" -g "$FARM_USER" -m 0700 "$TOKEN_DIR"
install -o root -g root -m 0440 "$HERE/horizon-tenant.sudoers" "$SUDOERS_DEST"
if ! visudo -c >/dev/null; then
  rm -f "$SUDOERS_DEST"
  fail "sudoers did not parse with horizon-tenant installed — removed it again"
fi
echo "install-tenant-host: ok"
