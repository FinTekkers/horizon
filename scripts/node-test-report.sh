#!/usr/bin/env bash
# HZ-953: `node --test` that also writes a JUnit report when the farm asks.
#
#   bash scripts/node-test-report.sh <suite> <node --test args>...
#
# HORIZON_TEST_REPORT_DIR unset: exactly `node --test <args>`. Set: the same
# run, plus server/scripts/junit-reporter.mjs writing <suite>.xml in that dir
# (farm/checks.py reads every *.xml there). Stdout keeps the reporter node
# would pick on its own, so the printed output does not change.
#
# A report must never fail a check: node --test exits 7 when it cannot open a
# reporter destination, so the file is created here first, and a dir that
# cannot take it falls back to the plain run.
set -u

suite="$1"
shift

dir="${HORIZON_TEST_REPORT_DIR:-}"
out="$dir/$suite.xml"
if [ -z "$dir" ] || ! { : >"$out"; } 2>/dev/null; then
  exec node --test "$@"
fi

# node's own default: spec on a terminal; off one, tap before Node 23, spec
# from 23 on.
reporter=spec
major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
if [ ! -t 1 ] && [ "${major:-0}" -lt 23 ] 2>/dev/null; then
  reporter=tap
fi

junit="$(cd "$(dirname "${BASH_SOURCE[0]}")/../server/scripts" && pwd)/junit-reporter.mjs"
exec node --test \
  --test-reporter="$reporter" --test-reporter-destination=stdout \
  --test-reporter="$junit" --test-reporter-destination="$out" \
  "$@"
