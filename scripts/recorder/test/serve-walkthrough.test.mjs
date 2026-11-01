// HZ-665: serve-walkthrough.sh, the throwaway board the scenarios are filmed
// against. Static checks on its commands (comments are ignored), plus its
// refusal to start without a login key. Nothing here starts a server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../serve-walkthrough.sh', import.meta.url))
const code = readFileSync(SCRIPT, 'utf8')
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

test('guardrail 3: the script never stops another process, and stays off serve.sh\'s ports and lock', () => {
  assert.doesNotMatch(code, /\bfuser\b/)
  assert.doesNotMatch(code, /\blsof\b/)
  assert.doesNotMatch(code, /\bkill\b[^\n]*(tcp|:\d|port)/i)
  assert.doesNotMatch(code, /\bflock\b/)
  assert.doesNotMatch(code, /horizon-screenshots-serve\.lock/)
  assert.doesNotMatch(code, /548[01]/)
  assert.match(code, /UI_PORT="\$\{WALKTHROUGH_UI_PORT:-5490\}"/)
  assert.match(code, /SERVER_PORT="\$\{WALKTHROUGH_SERVER_PORT:-5491\}"/)
})

test('guardrail 4: HORIZON_DB is always a fresh mktemp path, removed on exit, and server/data is never named', () => {
  assert.doesNotMatch(code, /server\/data/)
  assert.match(code, /^TMP="\$\(mktemp -d "\$\{TMPDIR:-\/tmp\}\/horizon-walkthrough-XXXXXX"\)"$/m)
  assert.match(code, /^DB="\$TMP\/horizon\.db"$/m)
  const dbs = [...code.matchAll(/HORIZON_DB=(\S+)/g)].map((m) => m[1])
  assert.ok(dbs.length >= 2, 'the server and the purge both set HORIZON_DB')
  assert.deepEqual([...new Set(dbs)], ['"$DB"'])
  assert.match(code, /^trap '[^']*rm -rf "\$TMP"[^']*' EXIT$/m)
})

test('the script refuses to start without SCREENSHOT_LOGIN_KEY, before it makes a temp dir', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'hz665-'))
  try {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmp }
    const run = spawnSync('bash', [SCRIPT], { env, encoding: 'utf8', timeout: 10_000 })
    assert.equal(run.status, 1, run.stderr)
    assert.match(run.stderr, /export SCREENSHOT_LOGIN_KEY first/)
    assert.deepEqual(readdirSync(tmp), [])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
