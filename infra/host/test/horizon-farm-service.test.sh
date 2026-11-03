#!/usr/bin/env bash
# Behavioral test harness for infra/host/horizon-farm.service and farm/run.sh
# (HZ-714). No live systemd: the unit's start path (EnvironmentFile=,
# Environment=, WorkingDirectory=, ExecStartPre=, ExecStart=) is replayed
# against a copy of the farm under $WORK, with /opt/horizon and
# /etc/horizon/farm.env rewritten to it. tmux, npm and the venv's pip/python
# are PATH or venv stubs that log their argv; the fake python also dumps its
# environment and its /proc cmdline.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR="$(cd "$HERE/.." && pwd)"
REPO_DIR="$(cd "$HOST_DIR/../.." && pwd)"
UNIT="$HOST_DIR/horizon-farm.service"
RUN_SH="$REPO_DIR/farm/run.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }
not_ok() { fail=$((fail + 1)); echo "not ok - $1"; }
expect() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else not_ok "$name"; fi; }
# expect_absent NAME FILE...: no sentinel value occurs in any of the files.
expect_absent() {
  local name="$1"; shift
  if grep -qF -f "$SENTINELS" "$@" 2>/dev/null; then not_ok "$name"; else ok "$name"; fi
}

# The dummy farm.env: sentinel values for the three secrets run.sh used to put
# on argv and for HZ-699's token, a non-prefixed extra name, a comment of each
# kind and a quoted value.
FARM_ENV="$WORK/farm.env"
cat >"$FARM_ENV" <<'EOF'
# farm settings
; also a comment
CLAUDE_CODE_OAUTH_TOKEN=sentinel-oauth-7f3a91
FARM_SHARED_SECRET="sentinel-shared-2b8c44"
WA_APPROVAL_SECRET='sentinel-approval-9d1e05'
PARVATI_GITHUB_TOKEN=sentinel-parvati-c6f270
HZ_TEST_EXTRA=1
QUOTED_SPACES="two words"
EOF
SENTINELS="$WORK/sentinels"
printf '%s\n' sentinel-oauth-7f3a91 sentinel-shared-2b8c44 sentinel-approval-9d1e05 sentinel-parvati-c6f270 >"$SENTINELS"

# read_env_file FILE: one KEY=VALUE per line, read the way systemd.exec(5)
# reads EnvironmentFile=: blank lines and lines starting with # or ; are
# skipped, whitespace around the line is trimmed, one pair of matching outer
# quotes is removed, and nothing is expanded ($, `export`, backslashes).
read_env_file() {
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    case "$line" in "" | "#"* | ";"*) continue ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    case "$value" in
      \"*\") value="${value:1:${#value}-2}" ;;
      \'*\') value="${value:1:${#value}-2}" ;;
    esac
    printf '%s=%s\n' "$key" "$value"
  done <"$1"
}

# A deployed copy of the repo's farm/ under $WORK/opt/horizon.
OPT="$WORK/opt/horizon"
FARM="$OPT/farm"
mkdir -p "$FARM/capture" "$FARM/.venv/bin"
cp "$RUN_SH" "$FARM/run.sh"
chmod +x "$FARM/run.sh"
: >"$FARM/requirements.txt"
: >"$FARM/capture/package-lock.json"
LOG="$WORK/argv.log"
DUMP="$WORK/farmd"
mkdir -p "$DUMP"

# Venv stubs: pip logs its argv; python is "farmd" and dumps what it got.
cat >"$FARM/.venv/bin/pip" <<EOF
#!/usr/bin/env bash
printf 'pip %s\n' "\$*" >>"$LOG"
EOF
cat >"$FARM/.venv/bin/python" <<EOF
#!/usr/bin/env bash
printf 'python %s\n' "\$*" >>"$LOG"
env >"$DUMP/env"
printf '%s\n' "\$@" >"$DUMP/argv"
tr '\0' ' ' </proc/\$\$/cmdline >"$DUMP/cmdline"
pwd >"$DUMP/cwd"
EOF
STUBS="$WORK/stubs"
mkdir -p "$STUBS"
# tmux: logs argv; TMUX_STUB_MODE=no-server answers like a box with no server.
cat >"$STUBS/tmux" <<EOF
#!/usr/bin/env bash
printf 'tmux %s\n' "\$*" >>"$LOG"
if [ "\${TMUX_STUB_MODE:-}" = no-server ]; then
  echo "no server running on /tmp/tmux-\$(id -u)/default" >&2
  exit 1
fi
EOF
cat >"$STUBS/npm" <<EOF
#!/usr/bin/env bash
printf 'npm %s\n' "\$*" >>"$LOG"
EOF
cat >"$STUBS/python3.13" <<EOF
#!/usr/bin/env bash
printf 'python3.13 %s\n' "\$*" >>"$LOG"
EOF
chmod +x "$FARM/.venv/bin/pip" "$FARM/.venv/bin/python" "$STUBS"/*

# The unit, with its host paths pointed at $WORK.
LOCAL_UNIT="$WORK/units/horizon-farm.service"
mkdir -p "$WORK/units"
sed -e "s|/etc/horizon/farm.env|$FARM_ENV|g" -e "s|/opt/horizon|$OPT|g" "$UNIT" >"$LOCAL_UNIT"
directive() { sed -n "s/^$1=//p" "$LOCAL_UNIT"; }

# farm_env: the environment systemd gives the unit's commands.
farm_env() {
  printf 'PATH=%s\n' "$STUBS:/usr/bin:/bin"
  read_env_file "$(directive EnvironmentFile)"
  directive Environment
}
mapfile -t UNIT_ENV < <(farm_env)

reset_log() { : >"$LOG"; rm -f "$DUMP"/*; }

# Metric 1: the unit's start path launches farmd with every farm.env name.
{
  reset_log
  read -r -a start <<<"$(directive ExecStart)"
  (cd "$(directive WorkingDirectory)" && env -i "${UNIT_ENV[@]}" "${start[@]}")
  expect "metric 1: farmd gets HZ_TEST_EXTRA (a non-prefixed farm.env name)" grep -qx 'HZ_TEST_EXTRA=1' "$DUMP/env"
  expect "metric 1: farmd gets PARVATI_GITHUB_TOKEN" grep -qx 'PARVATI_GITHUB_TOKEN=sentinel-parvati-c6f270' "$DUMP/env"
  expect "metric 1: farmd gets PYTHONUNBUFFERED=1" grep -qx 'PYTHONUNBUFFERED=1' "$DUMP/env"
  expect "metric 1: quotes are stripped as systemd does" grep -qx 'QUOTED_SPACES=two words' "$DUMP/env"
  expect "metric 1: comment lines are not settings" bash -c "! grep -q '^#\|^;' '$DUMP/env'"
  expect "metric 1: ExecStart runs the module farm.farmd" test "$(tr '\n' ' ' <"$DUMP/argv")" = "-m farm.farmd "
  expect "metric 1: farmd starts in the deployed repo root" test "$(cat "$DUMP/cwd")" = "$OPT"
}

# Metric 1: ExecStartPre succeeds on a fresh box with no tmux server.
{
  reset_log
  read -r -a pre <<<"$(directive ExecStartPre)"
  out="$WORK/prepare-no-server.out"
  (cd "$(directive WorkingDirectory)" && env -i "${UNIT_ENV[@]}" TMUX_STUB_MODE=no-server "${pre[@]}") >"$out" 2>&1
  rc=$?
  expect "metric 1: prepare exits 0 with no tmux server running" test "$rc" -eq 0
  expect "metric 1: prepare stops a legacy farm-daemon session" grep -qx 'tmux kill-session -t =farm-daemon' "$LOG"
  expect "metric 1: prepare installs requirements into the venv" grep -q "^pip install --quiet -r $FARM/requirements.txt" "$LOG"
  expect "metric 1: prepare installs the capture worker" grep -q "^npm --prefix $FARM/capture ci" "$LOG"
  expect "metric 1: prepare does not start farmd" test ! -e "$DUMP/env"
  expect_absent "guardrail 2: prepare (no server) prints no farm.env value" "$out"
}

# Metric 2: no farm.env value on any command line.
{
  expect_absent "metric 2: no sentinel in the unit's ExecStart/ExecStartPre lines" <(grep -E '^Exec' "$LOCAL_UNIT")
  expect "metric 2: the unit names no setting on an Exec line" bash -c "! sed -n 's/^Exec[A-Za-z]*=//p' '$UNIT' | grep -q '='"

  reset_log
  out="$WORK/prepare.out"
  (cd "$(directive WorkingDirectory)" && env -i "${UNIT_ENV[@]}" "${pre[@]}") >"$out" 2>&1
  expect "metric 2: prepare ran its commands" test -s "$LOG"
  expect_absent "metric 2: no sentinel in any argv prepare builds" "$LOG"
  expect_absent "guardrail 2: prepare prints no farm.env value (the journal)" "$out"

  reset_log
  out="$WORK/fg.out"
  (cd "$WORK" && env -i "${UNIT_ENV[@]}" "$FARM/run.sh" fg) >"$out" 2>&1
  expect "metric 2: fg launches farmd" test -s "$DUMP/cmdline"
  expect "metric 2: fg passes settings by inheritance" grep -qx 'HZ_TEST_EXTRA=1' "$DUMP/env"
  expect "metric 2: fg runs farmd from the repo root" test "$(cat "$DUMP/cwd")" = "$OPT"
  expect_absent "metric 2: no sentinel in any argv fg builds" "$LOG"
  expect_absent "metric 2: no sentinel in farmd's /proc cmdline under fg" "$DUMP/cmdline"
  expect_absent "guardrail 2: fg prints no farm.env value" "$out"
}

# Metric 3 and guardrail 1: the unit's directives.
{
  for line in 'Type=simple' 'KillMode=process' 'EnvironmentFile=/etc/horizon/farm.env' \
    'Environment=PYTHONUNBUFFERED=1' 'ExecStartPre=/opt/horizon/farm/run.sh prepare' \
    'ExecStart=/opt/horizon/farm/.venv/bin/python -m farm.farmd'; do
    expect "metric 3: unit has $line" grep -qx "$line" "$UNIT"
  done
  expect "metric 3: unit has no ExecStop (it would end farmd's sessions)" bash -c "! grep -q '^ExecStop' '$UNIT'"
  expect "metric 3: unit is no longer RemainAfterExit" bash -c "! grep -q '^RemainAfterExit' '$UNIT'"
  if ! command -v systemd-analyze >/dev/null 2>&1; then
    echo "ok - metric 3: systemd-analyze verify # SKIP systemd-analyze is not installed"
    pass=$((pass + 1))
  elif ! id -u ubuntu >/dev/null 2>&1; then
    echo "ok - metric 3: systemd-analyze verify # SKIP no ubuntu user on this host"
    pass=$((pass + 1))
  else
    expect "metric 3: systemd-analyze verify passes on the unit" systemd-analyze verify "$LOCAL_UNIT"
  fi
}

# Guardrail 4: the legacy no-argument mode still starts farm-daemon, for the
# old oneshot unit a release restarts before the owner installs the new one.
# Its argv leak is accepted for that window, so no sentinel check here.
{
  reset_log
  err="$WORK/legacy.err"
  (cd "$WORK" && env -i "${UNIT_ENV[@]}" "$FARM/run.sh") >/dev/null 2>"$err"
  expect "guardrail 4: legacy mode starts tmux session farm-daemon" grep -q '^tmux new-session -d -s farm-daemon ' "$LOG"
  expect "guardrail 4: legacy mode prints a deprecation line to stderr" grep -q 'deprecated (HZ-714)' "$err"
}

# Optional: an unknown mode is refused.
{
  reset_log
  "$FARM/run.sh" bogus >/dev/null 2>&1
  expect "run.sh refuses an unknown mode with exit 2" test "$?" -eq 2
  expect "run.sh runs nothing for an unknown mode" test ! -s "$LOG"
}

echo "# horizon-farm-service: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
