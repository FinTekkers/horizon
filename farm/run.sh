#!/bin/bash
# Start farmd (inside tmux session `farm-daemon` by default; `./run.sh fg` for foreground).
# Creates farm/.venv on first run — no global installs.
set -euo pipefail

FARM_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$FARM_DIR")"
VENV="$FARM_DIR/.venv"
PYTHON_BIN="${FARM_PYTHON:-python3.13}"

if [ ! -x "$VENV/bin/python" ]; then
  echo "Creating venv with $PYTHON_BIN…"
  "$PYTHON_BIN" -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
fi
"$VENV/bin/pip" install --quiet -r "$FARM_DIR/requirements.txt"

# tmux sessions inherit the tmux *server's* env, not this shell's — embed the
# farm-relevant vars into the command so `FARM_WA_ENABLED=1 ./run.sh` works.
ENV_VARS=""
while IFS= read -r kv; do
  ENV_VARS+=" $(printf '%q' "$kv")"
done < <(env | grep -E '^(FARM_|WA_|CLAUDE_|HORIZON_URL=)')
CMD="cd '$ROOT_DIR' && env$ENV_VARS '$VENV/bin/python' -m farm.farmd"

if [ "${1:-}" = "fg" ]; then
  eval "$CMD"
else
  tmux kill-session -t "=farm-daemon" 2>/dev/null || true
  tmux new-session -d -s farm-daemon "$CMD"
  echo "farmd starting in tmux session 'farm-daemon' (port ${FARM_PORT:-4100})"
  echo "  watch:  tmux attach -t farm-daemon"
  echo "  stop:   tmux kill-session -t farm-daemon"
fi
