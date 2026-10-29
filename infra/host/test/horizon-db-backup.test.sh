#!/usr/bin/env bash
# Behavioral test harness for infra/host/horizon-db-backup.sh (HZ-650).
# sqlite3 and zstd run for real against a small WAL-mode sample DB that a
# background "server" sqlite3 process keeps open (so its -wal stays non-empty,
# like the live DB). sqlite3 is always a PATH stub that logs its argv and
# passes through to the real binary; SQLITE_STUB_MODE makes it fail .backup or
# report a bad integrity_check. df and stat stubs fake free space and devices.
# Every run sets HOME, HORIZON_DB and HORIZON_BACKUP_DIR under $WORK.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR="$(cd "$HERE/.." && pwd)"
SCRIPT="$HOST_DIR/horizon-db-backup.sh"
SERVICE="$HOST_DIR/horizon-db-backup.service"
TIMER="$HOST_DIR/horizon-db-backup.timer"
REAL_HOME="$HOME"

for tool in sqlite3 zstd flock sha256sum systemd-analyze; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "not ok - $tool is required by this test and is not installed"
    exit 1
  fi
done
REAL_SQLITE3="$(command -v sqlite3)"
REAL_STAT="$(command -v stat)"

WORK="$(mktemp -d)"
STUBS="$WORK/stubs"
DF_STUBS="$WORK/df-stubs"
STAT_STUBS="$WORK/stat-stubs"
mkdir -p "$STUBS" "$DF_STUBS" "$STAT_STUBS"
HOLDER_PIDS=()
WRITER_PID=""
cleanup_all() {
  [ -n "$WRITER_PID" ] && kill "$WRITER_PID" 2>/dev/null
  for pid in "${HOLDER_PIDS[@]}"; do kill "$pid" 2>/dev/null; done
  rm -rf "$WORK"
}
trap cleanup_all EXIT
STAMP="$WORK/stamp"
touch "$STAMP"

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }
not_ok() { fail=$((fail + 1)); echo "not ok - $1"; }
expect() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else not_ok "$name"; fi; }

# sqlite3: log argv, then fail or fake output on the matching argument
# (anywhere in argv, so -cmd '.timeout …' cannot bypass the stub).
cat >"$STUBS/sqlite3" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"\${SQLITE_LOG:?}"
for arg in "\$@"; do
  case "\${SQLITE_STUB_MODE:-}:\$arg" in
    backup-fail:.backup*)
      dest="\$(printf '%s' "\$arg" | sed -n "s/^\\.backup '\\(.*\\)'\$/\\1/p")"
      [ -n "\$dest" ] && printf 'partial' >"\$dest"
      echo "Error: database is locked" >&2
      exit 1
      ;;
    integrity-fail:*integrity_check*)
      printf '%s\n' '*** in database main ***' 'Page 3: never used'
      exit 0
      ;;
  esac
done
exec "$REAL_SQLITE3" "\$@"
EOF
# df: DF_AVAIL bytes free everywhere, DF_LOW_AVAIL for DF_LOW_PATH.
cat >"$DF_STUBS/df" <<'EOF'
#!/usr/bin/env bash
avail="${DF_AVAIL:?}"
for arg in "$@"; do
  if [ -n "${DF_LOW_PATH:-}" ] && [ "$arg" = "$DF_LOW_PATH" ]; then avail="${DF_LOW_AVAIL:?}"; fi
done
printf 'Avail\n%s\n' "$avail"
EOF
# stat: report a different device for STAT_OTHER_DEV_PATH.
cat >"$STAT_STUBS/stat" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "-c" ] && [ "\${2:-}" = "%d" ] && [ "\${3:-}" = "\${STAT_OTHER_DEV_PATH:-}" ]; then
  echo 4242
  exit 0
fi
exec "$REAL_STAT" "\$@"
EOF
chmod +x "$STUBS/sqlite3" "$DF_STUBS/df" "$STAT_STUBS/stat"

# new_case NAME — sets CASE, SRC (stands in for server/data), DB, CASE_HOME
# and ROOT, and starts a holder sqlite3 (the stand-in for the live server) that
# keeps DB open with 500 rows still in its WAL. A sleeping writer holds the
# holder's stdin fifo open until the test exits.
new_case() {
  CASE="$WORK/$1"
  SRC="$CASE/server/data"
  DB="$SRC/horizon.db"
  CASE_HOME="$CASE/home"
  ROOT="$CASE_HOME/backups/horizon-db"
  mkdir -p "$SRC" "$CASE_HOME"
  mkfifo "$CASE/holder.fifo"
  "$REAL_SQLITE3" "$DB" <"$CASE/holder.fifo" >"$CASE/holder.out" 2>&1 &
  HOLDER_PIDS+=("$!")
  {
    cat <<'SQL'
PRAGMA journal_mode=WAL;
PRAGMA wal_autocheckpoint=0;
CREATE TABLE item(id INTEGER PRIMARY KEY, body TEXT);
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500)
INSERT INTO item(body) SELECT hex(randomblob(2000)) FROM n;
.print READY
SQL
    exec sleep 600
  } >"$CASE/holder.fifo" &
  HOLDER_PIDS+=("$!")
  for _ in $(seq 200); do grep -q READY "$CASE/holder.out" 2>/dev/null && break; sleep 0.05; done
  SRC_LIST_BEFORE="$(ls -A "$SRC")"
}

# run_backup [extra PATH dirs] [VAR=value ...] — runs the script with the case
# env; sets RC, OUT, ERR.
run_backup() {
  local path_prefix="$STUBS"
  while [ $# -gt 0 ] && [ -d "$1" ]; do path_prefix="$1:$path_prefix"; shift; done
  OUT="$CASE/run.out"
  ERR="$CASE/run.err"
  env HOME="$CASE_HOME" HORIZON_DB="$DB" HORIZON_BACKUP_DIR="$ROOT" \
    SQLITE_LOG="$CASE/sqlite.log" PATH="$path_prefix:$PATH" "$@" \
    bash "$SCRIPT" >"$OUT" 2>"$ERR"
  RC=$?
}

nightly_list() { ls -A "$ROOT/nightly" 2>/dev/null; }
src_unchanged() { [ "$(ls -A "$SRC")" = "$SRC_LIST_BEFORE" ]; }
staging_empty() { [ -z "$(ls -A "$ROOT/.staging" 2>/dev/null)" ]; }
sql() { "$REAL_SQLITE3" "$@"; }
seed_nightly() {
  mkdir -p "$ROOT/nightly"
  for i in 01 02 03 04 05 06 07 08; do
    echo "seed $i" | zstd -q -o "$ROOT/nightly/horizon-20260101T0000${i}Z.db.zst"
  done
}
sums() { (cd "$ROOT/nightly" && sha256sum -- *); }

# Metric 1: one verified .zst in nightly/ with the source's rows. The backup
# root is left to its default ($HOME/backups/horizon-db).
{
  new_case m1
  wal_size="$(stat -c %s "$DB-wal")"
  expect "metric 1: sample DB has a non-empty WAL" test "$wal_size" -gt 0
  expect "metric 1: sample rows are still only in the WAL" test "$(stat -c %s "$DB")" -lt "$wal_size"
  run_backup HORIZON_BACKUP_DIR=
  expect "metric 1: exits 0" test "$RC" -eq 0
  mapfile -t files < <(nightly_list)
  expect "metric 1: exactly one file in nightly/ under the default root" test "${#files[@]}" -eq 1
  expect "metric 1: named horizon-YYYYMMDDTHHMMSSZ.db.zst" bash -c "[[ '${files[0]:-}' =~ ^horizon-[0-9]{8}T[0-9]{6}Z\.db\.zst$ ]]"
  expect "metric 1: logs OK with the file" grep -q "^horizon-db-backup: OK $ROOT/nightly/${files[0]:-x} [0-9]" "$OUT"
  restored="$CASE/restored.db"
  zstd -d -q "$ROOT/nightly/${files[0]:-x}" -o "$restored"
  expect "metric 1: decompressed copy passes integrity_check" test "$(sql "$restored" 'PRAGMA integrity_check;')" = ok
  expect "metric 1: decompressed copy has the source's 500 rows" test "$(sql "$restored" 'SELECT count(*) FROM item;')" = 500
  expect "metric 1: used sqlite3 .backup read-only on the live DB" grep -qF -- "-readonly -cmd .timeout 10000 $DB .backup '$ROOT/.staging/horizon.db'" "$CASE/sqlite.log"
  expect "metric 1: staging is empty after the run" staging_empty
  expect "guardrail: no new file in server/data after a success" src_unchanged
  M1_HOME="$CASE_HOME"
  M1_ROOT="$ROOT"
}

# Metric 5 (automatable half): the DEPLOY.md restore rehearsal works on that copy.
{
  block="$WORK/restore-rehearsal.sh"
  awk '/<!-- restore-rehearsal -->/ {m=1; next} m && /^```bash/ {f=1; next} f && /^```/ {exit} f {print}' \
    "$HOST_DIR/DEPLOY.md" >"$block"
  expect "metric 5: DEPLOY.md has a marked restore-rehearsal block" grep -q 'zstd -d' "$block"
  mkdir -p "$WORK/tmp"
  rehearsal_out="$(HOME="$M1_HOME" TMPDIR="$WORK/tmp" bash -euo pipefail "$block" 2>&1)"
  expect "metric 5: rehearsal prints ok" test "$rehearsal_out" = ok
  r="$WORK/tmp/horizon-restore-check.db"
  expect "metric 5: restored copy has 500 rows" test "$(sql "$r" 'SELECT count(*) FROM item;' 2>/dev/null)" = 500
  expect "metric 5: restored copy is journal_mode delete" test "$(sql "$r" 'PRAGMA journal_mode;' 2>/dev/null)" = delete
  expect "metric 5: restored copy holds one file, no -wal" test ! -e "$r-wal"
}

# Metric 2: keep the 7 newest nightly copies; manual copies are untouched.
{
  new_case m2
  seed_nightly
  echo manual-root | zstd -q -o "$ROOT/manual-1014.db.zst"
  mkdir -p "$ROOT/manual"
  echo manual-dir | zstd -q -o "$ROOT/manual/horizon-20261014T120000Z.db.zst"
  manual_sums_before="$(cd "$ROOT" && sha256sum manual-1014.db.zst manual/horizon-20261014T120000Z.db.zst)"
  run_backup
  expect "metric 2: exits 0" test "$RC" -eq 0
  mapfile -t files < <(nightly_list)
  expect "metric 2: 7 copies remain" test "${#files[@]}" -eq 7
  expect "metric 2: the 2 oldest are gone" bash -c "[ ! -e '$ROOT/nightly/horizon-20260101T000001Z.db.zst' ] && [ ! -e '$ROOT/nightly/horizon-20260101T000002Z.db.zst' ]"
  survivors_ok=1
  for i in 03 04 05 06 07 08; do [ -e "$ROOT/nightly/horizon-20260101T0000${i}Z.db.zst" ] || survivors_ok=0; done
  expect "metric 2: the 6 newest seeds remain by name" test "$survivors_ok" -eq 1
  new_copy="$(sed -n 's/^horizon-db-backup: OK \([^ ]*\) .*/\1/p' "$OUT")"
  expect "metric 2: the new copy is one of the 7" bash -c "[ -n '$new_copy' ] && [ -e '$new_copy' ] && [ '${files[6]:-}' = \"\$(basename '$new_copy')\" ]"
  expect "metric 2: manual copies keep their sha256sum" test "$(cd "$ROOT" && sha256sum manual-1014.db.zst manual/horizon-20261014T120000Z.db.zst)" = "$manual_sums_before"
  expect "guardrail: no new file in server/data after pruning" src_unchanged
}

# assert_failed_cleanly NAME SUMS_BEFORE — asserts a failed run kept everything as it was.
assert_failed_cleanly() {
  local name="$1" sums_before="$2"
  expect "$name: exits non-zero" test "$RC" -ne 0
  expect "$name: logs an ERROR on stderr" grep -q '^horizon-db-backup: ERROR ' "$ERR"
  expect "$name: nightly/ unchanged (no new file, no copy deleted)" test "$(sums)" = "$sums_before"
  expect "$name: staging is empty" staging_empty
  expect "$name: no new file in server/data" src_unchanged
}

# Metric 3a: .backup fails (the stub also leaves a partial staged file).
{
  new_case m3a
  seed_nightly
  before="$(sums)"
  run_backup SQLITE_STUB_MODE=backup-fail
  assert_failed_cleanly "metric 3 (.backup fails)" "$before"
  expect "metric 3 (.backup fails): error names the backup stage" grep -q 'ERROR backup:' "$ERR"
}

# Metric 3b: integrity_check reports corruption; pruning must not run.
{
  new_case m3b
  seed_nightly
  before="$(sums)"
  run_backup SQLITE_STUB_MODE=integrity-fail
  assert_failed_cleanly "metric 3 (integrity_check fails)" "$before"
  expect "metric 3 (integrity_check fails): error names the integrity stage" grep -q 'ERROR integrity:' "$ERR"
  expect "metric 3 (integrity_check fails): the .backup did run" grep -qF '.backup' "$CASE/sqlite.log"
}

# Guardrail 3: free space below 2 x (db + wal) aborts before any copy.
{
  new_case disk-between
  seed_nightly
  before="$(sums)"
  db_b="$(stat -c %s "$DB")"
  wal_b="$(stat -c %s "$DB-wal")"
  need=$((2 * (db_b + wal_b)))
  run_backup "$DF_STUBS" DF_AVAIL=$((2 * db_b + wal_b))
  assert_failed_cleanly "disk below 2x(db+wal) but above 2x db" "$before"
  expect "disk below 2x(db+wal): ERROR disk" grep -q 'ERROR disk:' "$ERR"
  expect "disk below 2x(db+wal): no .backup call" bash -c "! grep -qF '.backup' '$CASE/sqlite.log' 2>/dev/null"

  run_backup "$DF_STUBS" DF_AVAIL="$need"
  expect "disk exactly 2x(db+wal): run goes ahead and exits 0" test "$RC" -eq 0
  expect "disk exactly 2x(db+wal): a new copy lands" test "$(nightly_list | wc -l)" -eq 7
}
{
  new_case disk-db-same-device
  run_backup "$DF_STUBS" DF_AVAIL=999999999999 DF_LOW_PATH="$SRC" DF_LOW_AVAIL=1
  expect "disk short only on the DB's filesystem, same device: not consulted, exits 0" test "$RC" -eq 0
}
{
  new_case disk-db-other-device
  seed_nightly
  before="$(sums)"
  run_backup "$STAT_STUBS" "$DF_STUBS" DF_AVAIL=999999999999 DF_LOW_PATH="$SRC" DF_LOW_AVAIL=1 STAT_OTHER_DEV_PATH="$SRC"
  assert_failed_cleanly "disk short only on the DB's other device" "$before"
  expect "disk short on the DB's device: ERROR disk names it" grep -q "ERROR disk: $SRC has 1 bytes free" "$ERR"
  expect "disk short on the DB's device: no .backup call" bash -c "! grep -qF '.backup' '$CASE/sqlite.log' 2>/dev/null"
}

# Guardrail 1: a writer keeps inserting while the backup runs; it is never
# blocked and the copy is a consistent snapshot between the two counts.
{
  new_case writer
  (
    while [ ! -e "$CASE/writer.stop" ]; do
      "$REAL_SQLITE3" "$DB" "INSERT INTO item(body) VALUES('w');" 2>>"$CASE/writer.err" || echo "exit $?" >>"$CASE/writer.err"
    done
  ) &
  WRITER_PID=$!
  for _ in $(seq 200); do [ "$(sql "$DB" 'SELECT count(*) FROM item;')" -gt 505 ] && break; sleep 0.02; done
  start_count="$(sql "$DB" 'SELECT count(*) FROM item;')"
  run_backup
  touch "$CASE/writer.stop"
  wait "$WRITER_PID"
  WRITER_PID=""
  end_count="$(sql "$DB" 'SELECT count(*) FROM item;')"
  expect "concurrent writer: backup exits 0" test "$RC" -eq 0
  expect "concurrent writer: the writer never failed (no SQLITE_BUSY)" test ! -s "$CASE/writer.err"
  expect "concurrent writer: rows were written during the run" test "$end_count" -gt "$start_count"
  copy="$(nightly_list | head -n 1)"
  zstd -d -q "$ROOT/nightly/$copy" -o "$CASE/restored.db"
  copy_count="$(sql "$CASE/restored.db" 'SELECT count(*) FROM item;')"
  expect "concurrent writer: copy count is between the start and end counts" \
    bash -c "[ '$copy_count' -ge '$start_count' ] && [ '$copy_count' -le '$end_count' ]"
  expect "concurrent writer: copy passes integrity_check" test "$(sql "$CASE/restored.db" 'PRAGMA integrity_check;')" = ok
}

# Metric 4 (automatable half): the units are valid and fire at 03:30 UTC.
{
  units="$WORK/units"
  mkdir -p "$units"
  cp "$SERVICE" "$TIMER" "$units/"
  sed -i "s|^ExecStart=.*|ExecStart=$SCRIPT|" "$units/horizon-db-backup.service"
  expect "metric 4: systemd-analyze verify passes on both units" \
    systemd-analyze verify "$units/horizon-db-backup.timer" "$units/horizon-db-backup.service"
  expect "metric 4: timer runs at 03:30 UTC" grep -qx 'OnCalendar=\*-\*-\* 03:30:00 UTC' "$TIMER"
  expect "metric 4: calendar spec parses" systemd-analyze calendar '*-*-* 03:30:00 UTC'
  expect "metric 4: timer is Persistent" grep -qx 'Persistent=true' "$TIMER"
  expect "metric 4: timer starts the backup service" grep -qx 'Unit=horizon-db-backup.service' "$TIMER"
  expect "metric 4: timer is wanted by timers.target" grep -qx 'WantedBy=timers.target' "$TIMER"
  expect "metric 4: service runs the deployed script" grep -qx 'ExecStart=/opt/horizon/infra/host/horizon-db-backup.sh' "$SERVICE"
}

# Guardrails 1 and 4: static scan of the script and units.
{
  code="$(grep -v '^[[:space:]]*#' "$SCRIPT")"
  expect "static: script never copies the DB with cp/rsync/dd/cat" \
    bash -c "! grep -En '(^|[^[:alnum:]_.-])(cp|rsync|dd|cat)[[:space:]].*\\\$\\{?(DB|HORIZON_DB)([^[:alnum:]_]|\$)' <<<\"\$1\"" _ "$code"
  expect "static: script copies with sqlite3 .backup" grep -qF '".backup ' "$SCRIPT"
  expect "static: script never calls systemctl" bash -c "! grep -q systemctl <<<\"\$1\"" _ "$code"
  expect "static: units load no EnvironmentFile" bash -c "! grep -q 'EnvironmentFile' '$SERVICE' '$TIMER'"
  expect "static: no secrets in script or units" bash -c "! grep -En 'SECRET|TOKEN|PASSWORD|KEY=' '$SCRIPT' '$SERVICE' '$TIMER'"
}

# Guardrail 2: no run touched the real DB or the real backup root.
{
  all_logs="$(cat "$WORK"/*/sqlite.log 2>/dev/null)"
  expect "isolation: sqlite3 logs exist for the runs" test -n "$all_logs"
  expect "isolation: no sqlite3 call named /opt/horizon" bash -c "! grep -qF '/opt/horizon' <<<\"\$1\"" _ "$all_logs"
  expect "isolation: no sqlite3 call named the real backup root" bash -c "! grep -qF '$REAL_HOME/backups' <<<\"\$1\"" _ "$all_logs"
  real_root="$REAL_HOME/backups/horizon-db"
  expect "isolation: the real backup root has nothing new" \
    bash -c "[ ! -e '$real_root' ] || [ -z \"\$(find '$real_root' -newer '$STAMP' -print -quit)\" ]"
  expect "isolation: every case root was under \$WORK" test "${M1_ROOT#"$WORK"/}" != "$M1_ROOT"
}

echo "# horizon-db-backup: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
