// Automated pass/fail proof for check.mjs (HZ-22) — the architecture and QA
// reviews on this ticket flagged that a deep-verification script with no
// test of its own can't be trusted to actually distinguish a healthy page
// from a broken one. This spins up two throwaway local HTTP servers — one
// serving the expected content, one that doesn't — and asserts check.mjs's
// exit code and SMOKE_RESULT line differ accordingly.
//
// Plain node:test, run outside Playwright's test runner (same pattern as
// ../fixtures/test-base.test.mjs) — see package.json's "test" script.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const execFileAsync = promisify(execFile)
const CHECK_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check.mjs')

async function serve(html) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { server, url: `http://127.0.0.1:${port}/` }
}

async function runCheck(url, expectedText) {
  try {
    const { stdout } = await execFileAsync('node', [CHECK_SCRIPT, url, expectedText], { timeout: 30_000 })
    return { code: 0, stdout }
  } catch (err) {
    // execFile rejects on non-zero exit; the process's own stdout/stderr
    // still ride along on the error object.
    return { code: err.code, stdout: err.stdout ?? '' }
  }
}

test('check.mjs passes against a page that actually renders the expected text', async () => {
  const { server, url } = await serve('<html><body><h1>Item Board</h1><p>3 items in flight</p></body></html>')
  try {
    const { code, stdout } = await runCheck(url, 'Item Board')
    assert.equal(code, 0)
    assert.match(stdout, /^SMOKE_RESULT=pass/m)
  } finally {
    server.close()
  }
})

test('check.mjs fails against a page missing the expected text', async () => {
  const { server, url } = await serve('<html><body><h1>Something went wrong</h1></body></html>')
  try {
    const { code, stdout } = await runCheck(url, 'Item Board')
    assert.equal(code, 1)
    assert.match(stdout, /^SMOKE_RESULT=fail:/m)
  } finally {
    server.close()
  }
})

test('check.mjs fails when the URL never responds', async () => {
  const { code, stdout } = await runCheck('http://127.0.0.1:1/', 'Item Board')
  assert.equal(code, 1)
  assert.match(stdout, /^SMOKE_RESULT=fail:/m)
})
