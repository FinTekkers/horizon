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
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

TMUX_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/hz-shtest-XXXXXX")" || exit 1
export TMUX_TMPDIR
unset TMUX

cleanup() {
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
  bash "$path"
  status=$?
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
