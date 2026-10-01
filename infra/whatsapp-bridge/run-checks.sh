#!/usr/bin/env bash
# HZ-142: gofmt + vet + test for the WhatsApp bridge patch (hzpoll).
#
# Wired into `npm test` at the repo root, which is what farm/checks.py detects
# — the Eng guardrail gate only ever looks at the root. Without this line the
# bridge's vote decryption, durability ordering and retry policy would be
# gated by nothing at all.
#
# SKIPS, loudly, on a host with no Go toolchain, rather than failing the whole
# suite. Same rule farm/checks.py applies to a check runner that is not
# installed: an absent runner is not a failing check.
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v go >/dev/null 2>&1; then
  echo "whatsapp-bridge: go is not installed on this host — skipped" >&2
  exit 0
fi

# gofmt is this repo's only real linter: package.json has no `lint` script, so
# farm/checks.py runs none. Keeping it here means the Go side is at least
# format-gated.
unformatted=$(gofmt -l .)
if [ -n "$unformatted" ]; then
  echo "whatsapp-bridge: gofmt would change these files:" >&2
  echo "$unformatted" >&2
  exit 1
fi

go vet ./...
go test ./...
