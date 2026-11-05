#!/usr/bin/env bash
# HZ-772: install-tenant-host.sh installs what a tenant Task job needs —
# tenant-entry, the tenant jobs root (root-owned, the farm user's group, 0711)
# and, through horizon-provision-run-user, a 2750 results dir for every
# existing hz-p<id> run user — and a second run changes nothing.
#
# Every system command the installer and the helper run (id, getent,
# groupadd, useradd, chown, chmod, install, visudo, runuser, stat) is a PATH
# stub that logs its argv to $LOG, as in horizon-provision-run-user.test.sh.
# getent lists $STUB_PASSWD for `getent passwd`, and reports hz-tenants as gid
# 997. install copies into $WORK and applies -m; its -o/-g are only checked
# in the logged argv, since this runs without root.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR="$(cd "$HERE/.." && pwd)"
INSTALLER="$HOST_DIR/install-tenant-host.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STUBS="$WORK/stubs"
LOG="$WORK/log"
LIBEXEC="$WORK/libexec"
HOME_ROOT="$WORK/home"
JOBS_ROOT="$WORK/tenant-jobs"
mkdir -p "$STUBS" "$HOME_ROOT/hz-p4" "$HOME_ROOT/hz-p12"

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }
not_ok() { fail=$((fail + 1)); echo "not ok - $1"; }
expect() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else not_ok "$name"; fi; }
logged() { grep -qF -- "$1" "$LOG"; }
not_logged() { ! grep -qE -- "$1" "$LOG"; }

REAL_STAT="$(command -v stat)"
for cmd in groupadd useradd chown chmod visudo; do
  printf '#!/usr/bin/env bash\nprintf "%%s %%s\\n" %s "$*" >>"${LOG:?}"\nexit 0\n' "$cmd" >"$STUBS/$cmd"
done
cat >"$STUBS/install" <<STUB
#!/usr/bin/env bash
printf 'install %s\n' "\$*" >>"\${LOG:?}"
dir=0 mode=
args=()
while [ "\$#" -gt 0 ]; do
  case "\$1" in
    -d) dir=1 ;;
    -o|-g) shift ;;
    -m) mode="\$2"; shift ;;
    *) args+=("\$1") ;;
  esac
  shift
done
case "\${args[-1]}" in "$WORK"/*) ;; *) exit 0 ;; esac
if [ "\$dir" = 1 ]; then mkdir -p "\${args[-1]}"; else cp "\${args[0]}" "\${args[1]}"; fi
[ -z "\$mode" ] || /bin/chmod "\$mode" "\${args[-1]}"
STUB
cat >"$STUBS/stat" <<STUB
#!/usr/bin/env bash
printf 'stat %s\n' "\$*" >>"\${LOG:?}"
[ "\$2" = %G ] && { echo ubuntu; exit 0; }
echo "0:0 \$("$REAL_STAT" -c %a "\${@: -1}")"
STUB
cat >"$STUBS/runuser" <<'STUB'
#!/usr/bin/env bash
printf 'runuser %s\n' "$*" >>"${LOG:?}"
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
shift
exec "$@"
STUB
cat >"$STUBS/id" <<'STUB'
#!/usr/bin/env bash
printf 'id %s\n' "$*" >>"${LOG:?}"
case "$1" in
  -u) echo 0 ;;
  -Gn) echo hz-tenants ;;
  *) exit 1 ;;
esac
STUB
cat >"$STUBS/getent" <<'STUB'
#!/usr/bin/env bash
printf 'getent %s\n' "$*" >>"${LOG:?}"
case "$1 ${2:-}" in
  "group hz-tenants") echo "hz-tenants:x:997:" ;;
  "passwd ") printf '%s\n' "${STUB_PASSWD:-}" ;;
  passwd\ *) printf '%s\n' "${STUB_PASSWD:-}" | grep "^$2:" || exit 2 ;;
  *) exit 2 ;;
esac
STUB
chmod +x "$STUBS"/*
printf '#!/bin/sh\nexit 0\n' >"$WORK/python-httpx"
chmod +x "$WORK/python-httpx"

# Two run users to backfill; a non-numeric hz-p name, an hz-p user outside
# hz-tenants and an ordinary user are left alone.
PASSWD="root:x:0:0::/root:/bin/bash
alice:x:1001:997::/home/alice:/bin/bash
hz-p4:x:990:997::$HOME_ROOT/hz-p4:/usr/sbin/nologin
hz-p12:x:991:997::$HOME_ROOT/hz-p12:/usr/sbin/nologin
hz-pX:x:992:997::$HOME_ROOT/hz-pX:/usr/sbin/nologin
hz-p5:x:993:1000::$HOME_ROOT/hz-p5:/usr/sbin/nologin"

run_installer() {
  : >"$LOG"
  env PATH="$STUBS:$PATH" LOG="$LOG" HORIZON_LIBEXEC="$LIBEXEC" HORIZON_FARM_PYTHON="$WORK/python-httpx" \
    HORIZON_TENANT_JOBS_ROOT="$JOBS_ROOT" HORIZON_RUN_USER_HOME_ROOT="$HOME_ROOT" STUB_PASSWD="$PASSWD" \
    bash "$INSTALLER" >"$WORK/out" 2>&1
  STATUS=$?
}

run_installer
expect "exit 0" test "$STATUS" -eq 0
expect "installs tenant-entry, root-owned 0755" grep -qE "^install -o root -g root -m 0755 [^ ]+ $LIBEXEC/tenant-entry\$" "$LOG"
expect "tenant-entry's body is the repo's" cmp -s <(tail -n +2 "$LIBEXEC/tenant-entry") <(tail -n +2 "$HOST_DIR/tenant-entry")
expect "installs the helper the backfill runs" test -x "$LIBEXEC/horizon-provision-run-user"
expect "creates the tenant jobs root: root, the farm user's group, 0711" logged "install -d -o root -g ubuntu -m 0711 $JOBS_ROOT"
expect "the tenant jobs root is mode 711" test "$("$REAL_STAT" -c %a "$JOBS_ROOT")" = 711
for id in 4 12; do
  expect "backfills hz-p$id: its results dir exists" test -d "$JOBS_ROOT/$id"
  expect "backfills hz-p$id: owned by hz-p$id, group ubuntu" logged "chown hz-p$id:ubuntu $JOBS_ROOT/$id"
  expect "backfills hz-p$id: mode 2750" logged "chmod 2750 $JOBS_ROOT/$id"
done
expect "leaves an hz-p user outside hz-tenants alone" test ! -e "$JOBS_ROOT/5"
expect "leaves a non-numeric hz-p name and other users alone" not_logged "hz-pX|alice|$JOBS_ROOT/(5|X)"
expect "only the two run users' dirs exist" test "$(ls "$JOBS_ROOT" | sort | tr '\n' ' ')" = "12 4 "
expect "the sudoers rules are still installed last" test "$(tail -1 "$LOG")" = "visudo -c"

# Idempotent: a second run reinstalls no tenant-entry and only re-applies modes.
run_installer
expect "a second run exits 0" test "$STATUS" -eq 0
expect "a second run leaves tenant-entry as it is" grep -q "tenant-entry already current" "$WORK/out"
expect "a second run does not reinstall tenant-entry" not_logged "^install .* $LIBEXEC/tenant-entry\$"
expect "a second run re-applies hz-p4's 2750" logged "chmod 2750 $JOBS_ROOT/4"
expect "a second run creates no user" not_logged "^useradd"
expect "a second run leaves the same dirs" test "$(ls "$JOBS_ROOT" | sort | tr '\n' ' ')" = "12 4 "

# No hz-tenants group yet (a fresh host): nothing to backfill, still ok.
: >"$LOG"
rm -rf "$JOBS_ROOT"
env PATH="$STUBS:$PATH" LOG="$LOG" HORIZON_LIBEXEC="$LIBEXEC" HORIZON_FARM_PYTHON="$WORK/python-httpx" \
  HORIZON_TENANT_JOBS_ROOT="$JOBS_ROOT" HORIZON_RUN_USER_HOME_ROOT="$HOME_ROOT" bash "$INSTALLER" >/dev/null 2>&1
STATUS=$?
expect "with no run users: exit 0" test "$STATUS" -eq 0
expect "with no run users: the root exists and is empty" test -d "$JOBS_ROOT" -a -z "$(ls "$JOBS_ROOT")"

echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
