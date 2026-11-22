#!/usr/bin/env bash
# HZ-716: runs the repo's shell tests — what the root `npm test` calls.
#
#   run-all.sh            every infra/host/test/*.test.sh and farm/**/*.test.sh
#   run-all.sh FILE...    just those files
#
# tmux session names are shared across a whole tmux server, and the host's
# default server is where the live farm's sessions live: on 2 Nov a shell
# test's `tmux kill-session -t =farm-daemon` reached it. So every test here
# runs with one private TMUX_TMPDIR (and TMUX unset), whatever the caller's
# environment says. On exit that server is stopped through its own socket
# path (`-S`) — never the default one — and the dir is removed.
#
# HZ-952: every file runs, even after one fails. Failed files are listed
# under `Failed shell tests:` at the end and the run exits 1. A file that
# exits 130 or 143 (Ctrl-C / SIGTERM) still stops the run at once.
#
# HZ-953: with HORIZON_TEST_REPORT_DIR set, the run also writes
# host-shell.xml there, one JUnit case per file (server/scripts/junit-cases.mjs).
# Nothing is printed for it and the exit status is the same: a report that
# cannot be written only loses the per-file detail.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

TMUX_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/hz-shtest-XXXXXX")" || exit 1
export TMUX_TMPDIR
unset TMUX

# HZ-953: one `status<TAB>seconds<TAB>name<TAB>file` line per file run. Its
# own temp file, not under TMUX_TMPDIR, which the tests themselves may clear.
CASES=""
if [ -n "${HORIZON_TEST_REPORT_DIR:-}" ]; then
  CASES="$(mktemp "${TMPDIR:-/tmp}/hz-shcases-XXXXXX" 2>/dev/null)" || CASES=""
fi

write_report() {
  [ -n "$CASES" ] || return 0
  if command -v node >/dev/null 2>&1; then
    node "$ROOT/server/scripts/junit-cases.mjs" --suite host-shell --tsv "$CASES" \
      --out "$HORIZON_TEST_REPORT_DIR/host-shell.xml" >/dev/null 2>&1
  fi
  rm -f "$CASES"
}

# EPOCHREALTIME in microseconds; a dot or a comma, by locale.
now_us() {
  local t="${EPOCHREALTIME:-0}"
  echo "${t/[.,]/}"
}

# record STATUS STARTED_US FILE
record() {
  [ -n "$CASES" ] || return 0
  local status="$1" us=$(($(now_us) - $2)) f="$3" rel="$3"
  case "$f" in "$ROOT"/*) rel="${f#"$ROOT"/}" ;; esac
  printf '%s\t%d.%06d\t%s\t%s\texited %s\n' \
    "$([ "$status" -eq 0 ] && echo pass || echo fail)" $((us / 1000000)) $((us % 1000000)) \
    "$(basename "$f")" "$rel" "$status" >>"$CASES" 2>/dev/null
}

cleanup() {
  write_report
  local socket="$TMUX_TMPDIR/tmux-$(id -u)/default"
  if [ -S "$socket" ] && command -v tmux >/dev/null 2>&1; then
    tmux -S "$socket" kill-server >/dev/null 2>&1
  fi
  rm -rf "$TMUX_TMPDIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$#" -gt 0 ]; then
  files=("$@")
else
  mapfile -t files < <(
    cd "$ROOT" && {
      printf '%s\n' infra/host/test/*.test.sh
      find farm -name '*.test.sh' -not -path '*/node_modules/*'
    } | sort
  )
fi

failed=()
for f in "${files[@]}"; do
  case "$f" in /*) path="$f" ;; *) path="$ROOT/$f" ;; esac
  started="$(now_us)"
  bash "$path"
  status=$?
  record "$status" "$started" "$f"
  case "$status" in
    0) ;;
    130|143) exit "$status" ;;
    *) failed+=("$f") ;;
  esac
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo "Failed shell tests:"
  printf '  - %s\n' "${failed[@]}"
  exit 1
fi
