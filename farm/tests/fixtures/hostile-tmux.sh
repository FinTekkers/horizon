#!/usr/bin/env bash
# HZ-716 fixture for test_shell_test_isolation.py: a shell test that does what
# HZ-714's did — starts and kills `farm-daemon`, then the whole server — on
# whatever tmux socket it inherits. It records that socket in $HZ716_MARKER,
# proving it reached a server at all. Deliberately not named *.test.sh, so
# infra/host/test/run-all.sh never picks it up on its own.
set -u
tmux new-session -d -s farm-daemon sleep 600 || exit 1
tmux display -p -t =farm-daemon '#{socket_path}' >"$HZ716_MARKER" || exit 1
tmux kill-session -t =farm-daemon || true
tmux kill-server || true
exit 0
