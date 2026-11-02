#!/usr/bin/env bash
# Behavioral test harness for HZ-697's host pieces: horizon-provision-run-user,
# horizon-tenant.sudoers and install-tenant-host.sh. Every system command they
# run (id, getent, groupadd, useradd, chown, chmod, install, visudo) is a PATH
# stub that logs its argv to $LOG, so nothing here touches a real user,
# group or sudoers file. STUB_USER_EXISTS makes getent report an existing
# hz-p<id> with STUB_SHELL, STUB_HOME and `id -Gn` STUB_GROUPS.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR="$(cd "$HERE/.." && pwd)"
HELPER="$HOST_DIR/horizon-provision-run-user"
SUDOERS="$HOST_DIR/horizon-tenant.sudoers"
INSTALLER="$HOST_DIR/install-tenant-host.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STUBS="$WORK/stubs"
LOG="$WORK/log"
mkdir -p "$STUBS"

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }
not_ok() { fail=$((fail + 1)); echo "not ok - $1"; }
expect() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else not_ok "$name"; fi; }

for cmd in groupadd useradd chown chmod install visudo; do
  cat >"$STUBS/$cmd" <<STUB
#!/usr/bin/env bash
printf '%s %s\n' "$cmd" "\$*" >>"\${LOG:?}"
[ "$cmd" = visudo ] && [ -n "\${STUB_VISUDO_FAIL:-}" ] && exit 1
exit 0
STUB
done
cat >"$STUBS/id" <<'STUB'
#!/usr/bin/env bash
printf 'id %s\n' "$*" >>"${LOG:?}"
case "$1" in
  -u) echo "${STUB_UID:-0}" ;;
  -Gn) echo "${STUB_GROUPS:-hz-tenants}" ;;
  *) exit 1 ;;
esac
STUB
cat >"$STUBS/getent" <<'STUB'
#!/usr/bin/env bash
printf 'getent %s\n' "$*" >>"${LOG:?}"
[ -n "${STUB_USER_EXISTS:-}" ] || exit 2
echo "$2:x:998:997::${STUB_HOME:-/home/$2}:${STUB_SHELL:-/usr/sbin/nologin}"
STUB
chmod +x "$STUBS"/*

# run_helper ARGS… — runs the helper with the stubs; leaves $LOG and $STATUS.
run_helper() {
  : >"$LOG"
  env PATH="$STUBS:$PATH" LOG="$LOG" bash "$HELPER" "$@" >"$WORK/out" 2>&1
  STATUS=$?
}
logged() { grep -qF -- "$1" "$LOG"; }
not_logged() { ! grep -qE -- "$1" "$LOG"; }

# ---- argument checks: anything but one positive integer id is refused ----

for bad in 0 -1 +1 1a ../1 '' 01 12345678901 '1 2' $'1\n2'; do
  run_helper "$bad"
  if [ "$STATUS" -eq 2 ] && not_logged '^(groupadd|useradd|chown|chmod)'; then ok "refuses id '$bad' before any change"; else not_ok "refuses id '$bad' before any change (status $STATUS)"; fi
done
run_helper
if [ "$STATUS" -eq 2 ] && [ ! -s "$LOG" ]; then ok "refuses no argument"; else not_ok "refuses no argument"; fi
run_helper 1 2
if [ "$STATUS" -eq 2 ] && [ ! -s "$LOG" ]; then ok "refuses two arguments"; else not_ok "refuses two arguments"; fi
: >"$LOG"
env PATH="$STUBS:$PATH" LOG="$LOG" STUB_UID=1000 bash "$HELPER" 42 >/dev/null 2>&1
STATUS=$?
if [ "$STATUS" -eq 2 ] && not_logged '^(groupadd|useradd)'; then ok "refuses to run as non-root"; else not_ok "refuses to run as non-root"; fi

# ---- a new run user: nologin, primary group hz-tenants, no -G, home 0700 ----

run_helper 42
expect "creates hz-p42: exit 0" test "$STATUS" -eq 0
expect "creates the hz-tenants group" logged "groupadd -f hz-tenants"
expect "useradd: system nologin user, primary group hz-tenants, own home" \
  logged "useradd --system --create-home --home-dir /home/hz-p42 --shell /usr/sbin/nologin --gid hz-tenants hz-p42"
expect "useradd gets no supplementary group, no password, no other shell" not_logged '^useradd .*(-G|--groups|-p |--password|sudo|ubuntu|/bin/(ba)?sh)'
expect "the home is owned by the run user" logged "chown hz-p42:hz-tenants /home/hz-p42"
expect "the home is chmod 700" logged "chmod 700 /home/hz-p42"
expect "never touches sudoers, a password or another user" not_logged 'sudoers|^(visudo|usermod|passwd|chpasswd) '

# ---- idempotent: an existing, correct hz-p42 is left as it is ----

: >"$LOG"
env PATH="$STUBS:$PATH" LOG="$LOG" STUB_USER_EXISTS=1 bash "$HELPER" 42 >/dev/null 2>&1
STATUS=$?
expect "a second run succeeds" test "$STATUS" -eq 0
expect "a second run creates no user" not_logged '^useradd'
expect "a second run still sets the home to 700" logged "chmod 700 /home/hz-p42"

# ---- an existing hz-p42 of any other shape is refused, never changed ----

for case in "STUB_SHELL=/bin/bash:a login shell" "STUB_GROUPS=hz-tenants sudo:a supplementary group" "STUB_HOME=/root:another home"; do
  setting="${case%%:*}"
  : >"$LOG"
  env PATH="$STUBS:$PATH" LOG="$LOG" STUB_USER_EXISTS=1 "$setting" bash "$HELPER" 42 >/dev/null 2>&1
  STATUS=$?
  if [ "$STATUS" -eq 2 ] && not_logged '^(useradd|chown|chmod)'; then ok "refuses an existing hz-p42 with ${case#*:}"; else not_ok "refuses an existing hz-p42 with ${case#*:}"; fi
done

# ---- the sudoers template: exactly the two rules ----

rules="$(grep -vE '^[[:space:]]*(#|$)' "$SUDOERS")"
expected="ubuntu ALL=(root) NOPASSWD: /usr/local/libexec/horizon/horizon-provision-run-user ^[1-9][0-9]*\$
ubuntu ALL=(%hz-tenants) NOPASSWD: /usr/local/libexec/horizon/tenant-entry \"\""
if [ "$rules" = "$expected" ]; then ok "sudoers has exactly the helper rule and the tenant-entry rule"; else not_ok "sudoers has exactly the helper rule and the tenant-entry rule"; printf '%s\n' "$rules"; fi
# A non-root PATH often lacks /usr/sbin, so look there too before skipping.
VISUDO="$(command -v visudo 2>/dev/null || true)"
[ -x "$VISUDO" ] || VISUDO=/usr/sbin/visudo
if [ -x "$VISUDO" ] && [ "$VISUDO" != "$STUBS/visudo" ]; then
  expect "sudoers template parses with visudo -cf" "$VISUDO" -cf "$SUDOERS"
fi

# ---- install-tenant-host.sh ----

: >"$LOG"
env PATH="$STUBS:$PATH" LOG="$LOG" bash "$INSTALLER" >/dev/null 2>&1
STATUS=$?
expect "installer: exit 0" test "$STATUS" -eq 0
expect "installer: checks the template first" test "$(head -1 "$LOG" | cut -d' ' -f1-2)" = "id -u"
expect "installer: visudo -cf before installing" test "$(sed -n 2p "$LOG")" = "visudo -cf $SUDOERS"
expect "installer: helper root-owned 0755" logged "install -o root -g root -m 0755 $HELPER /usr/local/libexec/horizon/horizon-provision-run-user"
expect "installer: token dir farm-owned 0700" logged "install -d -o ubuntu -g ubuntu -m 0700 /etc/horizon/tenant-tokens"
expect "installer: sudoers rules installed 0440" logged "install -o root -g root -m 0440 $SUDOERS /etc/sudoers.d/horizon-tenant"
expect "installer: whole sudoers tree checked last" test "$(tail -1 "$LOG")" = "visudo -c"

: >"$LOG"
env PATH="$STUBS:$PATH" LOG="$LOG" STUB_VISUDO_FAIL=1 bash "$INSTALLER" >/dev/null 2>&1
STATUS=$?
if [ "$STATUS" -ne 0 ] && not_logged '^install '; then ok "installer: a template that fails visudo installs nothing"; else not_ok "installer: a template that fails visudo installs nothing"; fi
: >"$LOG"
env PATH="$STUBS:$PATH" LOG="$LOG" STUB_UID=1000 bash "$INSTALLER" >/dev/null 2>&1
STATUS=$?
if [ "$STATUS" -ne 0 ] && [ "$(wc -l <"$LOG")" -eq 1 ]; then ok "installer: refuses to run as non-root"; else not_ok "installer: refuses to run as non-root"; fi

echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
