#!/usr/bin/env bash
# Behavioral test harness for HZ-697's host pieces: horizon-provision-run-user,
# horizon-tenant.sudoers and install-tenant-host.sh. Every system command they
# run (id, getent, groupadd, useradd, chown, chmod, install, visudo, runuser,
# stat) is a PATH stub that logs its argv to $LOG, so nothing here touches a
# real user, group or sudoers file. STUB_USER_EXISTS makes getent report an
# existing hz-p<id> with STUB_SHELL, STUB_HOME and `id -Gn` STUB_GROUPS.
#
# HZ-773: run-user homes live under $WORK/home (HORIZON_RUN_USER_HOME_ROOT),
# and runuser runs its command as the test user, so the helper's git writes
# are real. install copies into $WORK and applies -m; its -o root -g root is
# only checked in the logged argv, since this runs without root. stat reports
# every file as root:root (0:0) with its real mode, so the installer's
# "already current" path is reachable.
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

REAL_STAT="$(command -v stat)"
HOME_ROOT="$WORK/home"
LIBEXEC="$WORK/libexec"
mkdir -p "$HOME_ROOT/hz-p42"

for cmd in groupadd useradd chown chmod visudo; do
  cat >"$STUBS/$cmd" <<STUB
#!/usr/bin/env bash
printf '%s %s\n' "$cmd" "\$*" >>"\${LOG:?}"
[ "$cmd" = visudo ] && [ -n "\${STUB_VISUDO_FAIL:-}" ] && exit 1
exit 0
STUB
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
echo "0:0 \$("$REAL_STAT" -c %a "\${@: -1}")"
STUB
cat >"$STUBS/runuser" <<'STUB'
#!/usr/bin/env bash
printf 'runuser %s\n' "$*" >>"${LOG:?}"
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
shift
exec "$@"
STUB
# Interpreters for the installer's httpx check: one that imports it, one not.
printf '#!/bin/sh\nexit 0\n' >"$WORK/python-httpx"
printf '#!/bin/sh\nexit 1\n' >"$WORK/python-no-httpx"
chmod +x "$WORK/python-httpx" "$WORK/python-no-httpx"
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
echo "$2:x:998:997::${STUB_HOME:-${HORIZON_RUN_USER_HOME_ROOT:-/home}/$2}:${STUB_SHELL:-/usr/sbin/nologin}"
STUB
chmod +x "$STUBS"/*

# run_helper ARGS… — runs the helper with the stubs; leaves $LOG and $STATUS.
run_helper() {
  : >"$LOG"
  env PATH="$STUBS:$PATH" LOG="$LOG" HORIZON_RUN_USER_HOME_ROOT="$HOME_ROOT" bash "$HELPER" "$@" >"$WORK/out" 2>&1
  STATUS=$?
}
logged() { grep -qF -- "$1" "$LOG"; }
not_logged() { ! grep -qE -- "$1" "$LOG"; }

# ---- argument checks: anything but one positive integer id is refused ----

for bad in 0 -1 +1 1a ../1 '' 01 12345678901 '1 2' $'1\n2'; do
  run_helper "$bad"
  if [ "$STATUS" -eq 2 ] && not_logged '^(groupadd|useradd|chown|chmod|runuser)'; then ok "refuses id '$bad' before any change"; else not_ok "refuses id '$bad' before any change (status $STATUS)"; fi
done
run_helper
if [ "$STATUS" -eq 2 ] && [ ! -s "$LOG" ]; then ok "refuses no argument"; else not_ok "refuses no argument"; fi
run_helper 1 2
if [ "$STATUS" -eq 2 ] && [ ! -s "$LOG" ]; then ok "refuses two arguments"; else not_ok "refuses two arguments"; fi
: >"$LOG"
env PATH="$STUBS:$PATH" LOG="$LOG" HORIZON_RUN_USER_HOME_ROOT="$HOME_ROOT" STUB_UID=1000 bash "$HELPER" 42 >/dev/null 2>&1
STATUS=$?
if [ "$STATUS" -eq 2 ] && not_logged '^(groupadd|useradd)'; then ok "refuses to run as non-root"; else not_ok "refuses to run as non-root"; fi

# ---- a new run user: nologin, primary group hz-tenants, no -G, home 0700 ----

run_helper 42
expect "creates hz-p42: exit 0" test "$STATUS" -eq 0
expect "creates the hz-tenants group" logged "groupadd -f hz-tenants"
expect "useradd: system nologin user, primary group hz-tenants, own home" \
  logged "useradd --system --create-home --home-dir $HOME_ROOT/hz-p42 --shell /usr/sbin/nologin --gid hz-tenants hz-p42"
expect "useradd gets no supplementary group, no password, no other shell" not_logged '^useradd .*(-G|--groups|-p |--password|sudo|ubuntu|/bin/(ba)?sh)'
expect "the home is owned by the run user" logged "chown hz-p42:hz-tenants $HOME_ROOT/hz-p42"
expect "the home is chmod 700" logged "chmod 700 $HOME_ROOT/hz-p42"
expect "never touches sudoers, a password or another user" not_logged 'sudoers|^(visudo|usermod|passwd|chpasswd) '

# ---- idempotent: an existing, correct hz-p42 is left as it is ----

: >"$LOG"
env PATH="$STUBS:$PATH" LOG="$LOG" HORIZON_RUN_USER_HOME_ROOT="$HOME_ROOT" STUB_USER_EXISTS=1 bash "$HELPER" 42 >/dev/null 2>&1
STATUS=$?
expect "a second run succeeds" test "$STATUS" -eq 0
expect "a second run creates no user" not_logged '^useradd'
expect "a second run still sets the home to 700" logged "chmod 700 $HOME_ROOT/hz-p42"

# ---- an existing hz-p42 of any other shape is refused, never changed ----

for case in "STUB_SHELL=/bin/bash:a login shell" "STUB_GROUPS=hz-tenants sudo:a supplementary group" "STUB_HOME=/root:another home"; do
  setting="${case%%:*}"
  : >"$LOG"
  env PATH="$STUBS:$PATH" LOG="$LOG" HORIZON_RUN_USER_HOME_ROOT="$HOME_ROOT" STUB_USER_EXISTS=1 "$setting" bash "$HELPER" 42 >/dev/null 2>&1
  STATUS=$?
  if [ "$STATUS" -eq 2 ] && not_logged '^(useradd|chown|chmod|runuser)'; then ok "refuses an existing hz-p42 with ${case#*:}"; else not_ok "refuses an existing hz-p42 with ${case#*:}"; fi
done

# ---- HZ-773: the run user's git identity, written as the run user ----

GITCONFIG="$HOME_ROOT/hz-p42/.gitconfig"
gitget() { git config --file "$GITCONFIG" --get "$1"; }
rm -f "$GITCONFIG"
run_helper 42
expect "git identity: exit 0" test "$STATUS" -eq 0
expect "git identity: user.name is set" test "$(gitget user.name)" = "Horizon (hz-p42)"
expect "git identity: user.email is set" test "$(gitget user.email)" = "hz-p42@noreply.shoreward.ai"
expect "git identity: written by the run user through runuser" logged "runuser -u hz-p42 -- env HOME=$HOME_ROOT/hz-p42 sh -c"
expect "git identity: root never chowns or chmods .gitconfig" not_logged '^(chown|chmod) .*\.gitconfig'
expect "git identity: a new .gitconfig is 0600" test "$("$REAL_STAT" -c %a "$GITCONFIG")" = 600

# Metric 2: a commit with that HOME finds the identity in ~/.gitconfig alone —
# no system config, no GIT_* or EMAIL variables, no guess from the host name.
REPO="$WORK/repo"
git init -q "$REPO"
env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL -u EMAIL -u XDG_CONFIG_HOME \
  HOME="$HOME_ROOT/hz-p42" GIT_CONFIG_NOSYSTEM=1 \
  git -C "$REPO" -c user.useConfigOnly=true commit -q --allow-empty -m t >"$WORK/commit.out" 2>&1
STATUS=$?
expect "git identity: a commit as hz-p42 succeeds" test "$STATUS" -eq 0
expect "git identity: no Author identity unknown" bash -c '! grep -q "Author identity unknown" "$1"' _ "$WORK/commit.out"
expect "git identity: the commit's author is the run user" \
  test "$(git -C "$REPO" log -1 --format='%an <%ae>' 2>/dev/null)" = "Horizon (hz-p42) <hz-p42@noreply.shoreward.ai>"

# A value already there (a hand fix) is kept; only the missing one is added.
rm -f "$GITCONFIG"
git config --file "$GITCONFIG" user.name "Parvati Ops"
run_helper 42
expect "git identity: a pre-set user.name is left unchanged" test "$(gitget user.name)" = "Parvati Ops"
expect "git identity: the missing user.email is still added" test "$(gitget user.email)" = "hz-p42@noreply.shoreward.ai"
before="$(cat "$GITCONFIG")"
run_helper 42
expect "git identity: a second run changes nothing" test "$(cat "$GITCONFIG")" = "$before"

# A planted symlink is refused, and what it points at is never written.
printf 'victim\n' >"$WORK/victim"
cp "$WORK/victim" "$WORK/victim.orig"
rm -f "$GITCONFIG"
ln -s "$WORK/victim" "$GITCONFIG"
run_helper 42
expect "git identity: a symlinked .gitconfig is refused" test "$STATUS" -eq 2
expect "git identity: the symlink's target is byte-identical" cmp -s "$WORK/victim" "$WORK/victim.orig"
expect "git identity: no git write for a symlinked .gitconfig" not_logged '^runuser '
expect "git identity: no chown or chmod of the symlink" not_logged '^(chown|chmod) .*\.gitconfig'
rm -f "$GITCONFIG"

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

ENTRY="$HOST_DIR/tenant-entry"
INSTALLED="$LIBEXEC/tenant-entry"
# run_installer [VAR=value…] — the installer with the stubs and a $WORK libexec.
run_installer() {
  : >"$LOG"
  env PATH="$STUBS:$PATH" LOG="$LOG" HORIZON_LIBEXEC="$LIBEXEC" HORIZON_FARM_PYTHON="$WORK/python-httpx" "$@" \
    bash "$INSTALLER" >"$WORK/out" 2>&1
  STATUS=$?
}

run_installer
expect "installer: exit 0" test "$STATUS" -eq 0
expect "installer: checks the template first" test "$(head -1 "$LOG" | cut -d' ' -f1-2)" = "id -u"
expect "installer: visudo -cf before installing" test "$(sed -n 2p "$LOG")" = "visudo -cf $SUDOERS"
expect "installer: helper root-owned 0755" logged "install -o root -g root -m 0755 $HELPER $LIBEXEC/horizon-provision-run-user"
expect "installer: token dir farm-owned 0700" logged "install -d -o ubuntu -g ubuntu -m 0700 /etc/horizon/tenant-tokens"
expect "installer: sudoers rules installed 0440" logged "install -o root -g root -m 0440 $SUDOERS /etc/sudoers.d/horizon-tenant"
expect "installer: whole sudoers tree checked last" test "$(tail -1 "$LOG")" = "visudo -c"

# HZ-773 metric 1: tenant-entry, root-owned 0755, the venv's python on line 1
# and every byte below it the repo's own.
expect "installer: tenant-entry installed root-owned 0755" grep -qE "^install -o root -g root -m 0755 [^ ]+ $INSTALLED\$" "$LOG"
expect "installer: tenant-entry is mode 755" test "$("$REAL_STAT" -c %a "$INSTALLED")" = 755
expect "installer: tenant-entry's shebang is the farm venv's python" test "$(head -1 "$INSTALLED")" = "#!$WORK/python-httpx"
expect "installer: tenant-entry's body matches the repo byte for byte" cmp -s <(tail -n +2 "$INSTALLED") <(tail -n +2 "$ENTRY")
expect "installer: the default venv python is horizon-farm.service's" grep -qF 'FARM_PY="${HORIZON_FARM_PYTHON:-/opt/horizon/farm/.venv/bin/python}"' "$INSTALLER"
staged_src="$(grep -E " $INSTALLED\$" "$LOG" | awk '{print $(NF-1)}')"
expect "installer: removes its staged copy" test ! -e "$staged_src"

# Guardrail 4: a second run installs no tenant-entry; a hand chmod is repaired.
run_installer
expect "installer: a second run exits 0" test "$STATUS" -eq 0
expect "installer: a second run does not reinstall tenant-entry" not_logged "^install .* $INSTALLED\$"
/bin/chmod 644 "$INSTALLED"
run_installer
expect "installer: a chmod 644 tenant-entry is reinstalled 0755" grep -qE "^install -o root -g root -m 0755 [^ ]+ $INSTALLED\$" "$LOG"
expect "installer: and is mode 755 again" test "$("$REAL_STAT" -c %a "$INSTALLED")" = 755

# R9: a python without httpx, or none at all, stops the run before any change.
for py in "$WORK/python-no-httpx:a python without httpx" "$WORK/no-such-python:a missing python"; do
  rm -rf "$LIBEXEC"
  run_installer HORIZON_FARM_PYTHON="${py%%:*}"
  if [ "$STATUS" -ne 0 ] && not_logged '^(install|groupadd) ' && [ ! -e "$INSTALLED" ]; then
    ok "installer: refuses ${py#*:} and installs nothing"
  else
    not_ok "installer: refuses ${py#*:} and installs nothing"
  fi
done

: >"$LOG"
env PATH="$STUBS:$PATH" LOG="$LOG" HORIZON_LIBEXEC="$LIBEXEC" HORIZON_FARM_PYTHON="$WORK/python-httpx" STUB_VISUDO_FAIL=1 bash "$INSTALLER" >/dev/null 2>&1
STATUS=$?
if [ "$STATUS" -ne 0 ] && not_logged '^install '; then ok "installer: a template that fails visudo installs nothing"; else not_ok "installer: a template that fails visudo installs nothing"; fi
: >"$LOG"
env PATH="$STUBS:$PATH" LOG="$LOG" HORIZON_LIBEXEC="$LIBEXEC" HORIZON_FARM_PYTHON="$WORK/python-httpx" STUB_UID=1000 bash "$INSTALLER" >/dev/null 2>&1
STATUS=$?
if [ "$STATUS" -ne 0 ] && [ "$(wc -l <"$LOG")" -eq 1 ]; then ok "installer: refuses to run as non-root"; else not_ok "installer: refuses to run as non-root"; fi

echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
