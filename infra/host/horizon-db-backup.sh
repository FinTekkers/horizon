#!/usr/bin/env bash
# Nightly online backup of the Horizon database (HZ-650). Run by
# horizon-db-backup.timer as ubuntu, no sudo:
#   1. take an online-safe copy with sqlite3 ".backup" (consistent while the
#      server writes; the live DB is opened read-only and never stopped),
#   2. check the copy with PRAGMA integrity_check (must print exactly "ok"),
#   3. compress it with zstd and test the archive,
#   4. publish it into $ROOT/nightly/ with an atomic rename,
#   5. only then prune nightly/ to the newest $KEEP copies.
# Any failure logs "horizon-db-backup: ERROR <stage>: <detail>" to stderr,
# exits 1 and leaves every existing copy in place. Work files live in
# $ROOT/.staging/ (same filesystem as nightly/), never next to the live DB.
#
# Env (no secrets):
#   HORIZON_DB             live DB   (default /opt/horizon/server/data/horizon.db)
#   HORIZON_BACKUP_DIR     backup root (default $HOME/backups/horizon-db)
#   HORIZON_BACKUP_KEEP    nightly copies to keep (default 7)
#   HORIZON_BACKUP_TIMEOUT max time for the .backup step (default 2h)
set -euo pipefail

DB="${HORIZON_DB:-/opt/horizon/server/data/horizon.db}"
ROOT="${HORIZON_BACKUP_DIR:-$HOME/backups/horizon-db}"
KEEP="${HORIZON_BACKUP_KEEP:-7}"
COPY_TIMEOUT="${HORIZON_BACKUP_TIMEOUT:-2h}"
NIGHTLY="$ROOT/nightly"
STAGE="$ROOT/.staging"

log() { echo "horizon-db-backup: $*"; }
fail() { echo "horizon-db-backup: ERROR $1: $2" >&2; exit 1; }

case "$KEEP" in '' | *[!0-9]* | 0) fail config "HORIZON_BACKUP_KEEP must be a positive integer, got '$KEEP'" ;; esac
for tool in sqlite3 zstd flock timeout ionice df stat; do
  command -v "$tool" >/dev/null 2>&1 || fail config "$tool not found on PATH"
done
[ -f "$DB" ] && [ -r "$DB" ] || fail source "$DB is missing or unreadable"

mkdir -p "$NIGHTLY" "$STAGE" || fail config "cannot create $NIGHTLY or $STAGE"

# One run at a time. The staging cleanup trap is only set once we hold the
# lock, so a refused run never touches another run's work files.
exec 9>"$ROOT/.lock" || fail lock "cannot open $ROOT/.lock"
flock -n 9 || fail lock "another backup is already running"
cleanup() { find "$STAGE" -mindepth 1 -delete 2>/dev/null || true; }
trap cleanup EXIT
cleanup

# Free space: abort below 2 x (db + wal) on the backup filesystem, and on the
# live DB's filesystem too when it is a different device.
db_bytes="$(stat -c %s "$DB")" || fail disk "cannot stat $DB"
wal_bytes=0
if [ -f "$DB-wal" ]; then wal_bytes="$(stat -c %s "$DB-wal")" || fail disk "cannot stat $DB-wal"; fi
need=$((2 * (db_bytes + wal_bytes)))

avail_bytes() {
  local out
  out="$(df -B1 --output=avail "$1" 2>/dev/null | tail -n 1 | tr -d '[:space:]')" || return 1
  case "$out" in '' | *[!0-9]*) return 1 ;; esac
  echo "$out"
}
check_space() {
  local avail
  avail="$(avail_bytes "$1")" || fail disk "cannot read free space for $1"
  if [ "$avail" -lt "$need" ]; then
    fail disk "$1 has $avail bytes free, need $need (2 x db+wal)"
  fi
}
check_space "$ROOT"
db_dir="$(dirname "$DB")"
root_dev="$(stat -c %d "$ROOT")" || fail disk "cannot stat $ROOT"
db_dev="$(stat -c %d "$db_dir")" || fail disk "cannot stat $db_dir"
if [ "$db_dev" != "$root_dev" ]; then check_space "$db_dir"; fi

# Online copy. -readonly: the backup never writes to (or checkpoints) the live
# DB. .timeout rides out a brief SQLITE_BUSY during a server checkpoint.
staged="$STAGE/horizon.db"
if ! timeout "$COPY_TIMEOUT" nice -n 10 ionice -c3 \
  sqlite3 -bail -readonly -cmd '.timeout 10000' "$DB" ".backup '$staged'"; then
  fail backup "sqlite3 .backup of $DB failed or timed out after $COPY_TIMEOUT"
fi
[ -s "$staged" ] || fail backup "sqlite3 .backup wrote no copy"

# The copy keeps the source's WAL flag; make it one self-contained file.
mode="$(sqlite3 -bail "$staged" 'PRAGMA journal_mode=DELETE;')" || fail backup "cannot set journal_mode on the copy"
[ "$mode" = "delete" ] || fail backup "journal_mode on the copy is '$mode', expected delete"

check="$(sqlite3 -bail "$staged" 'PRAGMA integrity_check;' 2>&1)" || fail integrity "integrity_check could not run: $check"
[ "$check" = "ok" ] || fail integrity "integrity_check on the copy: $(echo "$check" | head -n 5 | tr '\n' ' ')"

packed="$STAGE/horizon.db.zst"
nice -n 10 zstd -q -3 -T2 "$staged" -o "$packed" || fail compress "zstd failed"
zstd -q -t "$packed" || fail compress "zstd -t rejected the archive"
rm -f -- "$staged"

target="$NIGHTLY/horizon-$(date -u +%Y%m%dT%H%M%SZ).db.zst"
if [ -e "$target" ]; then fail publish "$target already exists"; fi
mv -- "$packed" "$target" || fail publish "cannot move the archive into $NIGHTLY"
bytes="$(stat -c %s "$target")"

# Prune only nightly copies, only now that the new one is in place. Names sort
# by time, so the glob's order is oldest first.
shopt -s nullglob
copies=("$NIGHTLY"/horizon-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.db.zst)
shopt -u nullglob
excess=$((${#copies[@]} - KEEP))
for ((i = 0; i < excess; i++)); do
  if rm -f -- "${copies[$i]}"; then
    log "pruned ${copies[$i]}"
  else
    echo "horizon-db-backup: WARN prune: cannot delete ${copies[$i]}" >&2
  fi
done

log "OK $target $bytes"
