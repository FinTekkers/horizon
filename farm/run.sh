#!/bin/bash
# farmd's set-up and start. Creates farm/.venv on first run — no global installs.
#
#   ./run.sh prepare   venv + capture worker, then stop any legacy farm-daemon
#                      tmux session. horizon-farm.service's ExecStartPre (HZ-714):
#                      systemd then runs the venv's python as farmd itself.
#   ./run.sh fg        prepare, then exec farmd in the foreground (by hand).
#   ./run.sh           legacy: farmd inside tmux session `farm-daemon`, for the
#                      old oneshot unit only until the new one is installed.
#
# prepare and fg never put a setting on a command line: farmd inherits this
# shell's environment (systemd's EnvironmentFile=/etc/horizon/farm.env).
set -euo pipefail

FARM_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$FARM_DIR")"
VENV="$FARM_DIR/.venv"
PYTHON_BIN="${FARM_PYTHON:-python3.13}"
MODE="${1:-}"

case "$MODE" in
  prepare | fg | "") ;;
  *)
    echo "usage: $0 [prepare|fg]" >&2
    exit 2
    ;;
esac

prepare() {
  if [ ! -x "$VENV/bin/python" ]; then
    echo "Creating venv with $PYTHON_BIN…"
    "$PYTHON_BIN" -m venv "$VENV"
    "$VENV/bin/pip" install --quiet --upgrade pip
  fi
  "$VENV/bin/pip" install --quiet -r "$FARM_DIR/requirements.txt"
  # HZ-814: the Postgres driver for Execute's db_changes snapshots.
  "$VENV/bin/pip" install --quiet -r "$FARM_DIR/requirements-db.txt"

  # HZ-506: the screenshot capture worker's pinned Playwright. Reinstalled when
  # missing or older than its lockfile; a failure only warns — the screenshots
  # slot then fails with "farm capture worker not installed".
  CAPTURE_DIR="$FARM_DIR/capture"
  if [ ! -d "$CAPTURE_DIR/node_modules/playwright" ] || [ "$CAPTURE_DIR/package-lock.json" -nt "$CAPTURE_DIR/node_modules/.package-lock.json" ]; then
    echo "Installing the screenshot capture worker…"
    npm --prefix "$CAPTURE_DIR" ci --no-audit --no-fund --silent || echo "warning: npm ci in $CAPTURE_DIR failed — screenshots cannot be captured" >&2
  fi
}

case "$MODE" in
  prepare)
    prepare
    # HZ-714: a farmd left in tmux by the old unit would hold port 4100. No
    # tmux server (a fresh box) is not an error.
    tmux kill-session -t "=farm-daemon" 2>/dev/null || true
    ;;
  fg)
    prepare
    cd "$ROOT_DIR"
    exec "$VENV/bin/python" -m farm.farmd
    ;;
  "")
    echo "run.sh: tmux mode is deprecated (HZ-714) — install the new horizon-farm.service; see infra/host/DEPLOY.md" >&2
    prepare
    # tmux sessions inherit the tmux *server's* env, not this shell's — embed the
    # farm-relevant vars into the command so `FARM_WA_ENABLED=1 ./run.sh` works.
    ENV_VARS=""
    while IFS= read -r kv; do
      ENV_VARS+=" $(printf '%q' "$kv")"
    done < <(env | grep -E '^(FARM_|WA_|CLAUDE_|HORIZON_URL=)')
    CMD="cd '$ROOT_DIR' && env$ENV_VARS '$VENV/bin/python' -m farm.farmd"
    tmux kill-session -t "=farm-daemon" 2>/dev/null || true
    tmux new-session -d -s farm-daemon "$CMD"
    echo "farmd starting in tmux session 'farm-daemon' (port ${FARM_PORT:-4100})"
    echo "  watch:  tmux attach -t farm-daemon"
    echo "  stop:   tmux kill-session -t farm-daemon"
    ;;
esac
