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
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

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

// ---- HZ-789: live-data markers (--live=<json>) ----
// A page that shows live data can render its static text while every live
// section shows "unavailable" (US-250, US-298, US-307). With --live the check
// also needs one live value. run_smoke_check (farm/step_agent.py) passes no
// screenshot path, so --live arrives straight after the text: both argv
// shapes are covered.

async function runCheckArgs(args) {
  try {
    const { stdout } = await execFileAsync('node', [CHECK_SCRIPT, ...args], { timeout: 45_000 })
    return { code: 0, stdout }
  } catch (err) {
    return { code: err.code, stdout: err.stdout ?? '' }
  }
}

const TIPS_TEXT = 'Real clean price (FedInvest'
const TIPS_SECTIONS = ['security', 'price', 'CPI-U', 'valuation']
const TIPS_LIVE = `--live=${JSON.stringify({
  path: '/free/tips',
  liveValue: '[data-live-value]',
  sections: TIPS_SECTIONS.map((name) => ({ name, selector: `[data-live-section="${name}"]`, emptyText: ['unavailable'] })),
})}`

function tipsPage(sectionBody) {
  const sections = TIPS_SECTIONS.map((name) => `<section data-live-section="${name}"><h2>${name}</h2>${sectionBody(name)}</section>`)
  return `<html><body><h1>TIPS</h1><p>${TIPS_TEXT}) for every TIPS</p>${sections.join('')}</body></html>`
}

async function withPage(html, fn) {
  const { server, url } = await serve(html)
  try {
    return await fn(`${url}free/tips`)
  } finally {
    server.close()
  }
}

test('live: every declared section showing "unavailable" fails and names all four (US-298)', async () => {
  await withPage(tipsPage(() => '<p>unavailable</p>'), async (url) => {
    const { code, stdout } = await runCheckArgs([url, TIPS_TEXT, TIPS_LIVE])
    assert.equal(code, 1)
    assert.match(stdout, /^SMOKE_RESULT=fail: live data unavailable — every live section shows its unavailable or empty state: security, price, CPI-U, valuation \(/m)
  })
})

for (const withShot of [false, true]) {
  test(`live: one rendered live value passes and names its marker and value (${withShot ? 'with' : 'no'} screenshot path)`, async () => {
    const html = tipsPage((name) => (name === 'price' ? '<p>Clean price <span data-live-value>101.23</span></p>' : '<p>unavailable</p>'))
    await withPage(html, async (url) => {
      const shot = join(tmpdir(), `hz-789-smoke-${process.pid}.png`)
      const args = withShot ? [url, TIPS_TEXT, shot, TIPS_LIVE] : [url, TIPS_TEXT, TIPS_LIVE]
      const { code, stdout } = await runCheckArgs(args)
      if (withShot) await rm(shot, { force: true })
      assert.equal(code, 0, stdout)
      assert.match(stdout, /^SMOKE_RESULT=pass — "Real clean price \(FedInvest" rendered at .*; live value \[data-live-value\] = "101\.23"$/m)
    })
  })
}

test('live: a value that arrives after load passes (the check polls)', async () => {
  const html = tipsPage(() => '<p class="slot">Loading…</p>').replace(
    '</body>',
    `<script>setTimeout(() => { document.querySelector('[data-live-section="price"] .slot').innerHTML = '<span data-live-value>101.23</span>' }, 1000)</script></body>`,
  )
  await withPage(html, async (url) => {
    const { code, stdout } = await runCheckArgs([url, TIPS_TEXT, TIPS_LIVE])
    assert.equal(code, 0, stdout)
    assert.match(stdout, /; live value \[data-live-value\] = "101\.23"$/m)
  })
})

test('live: a placeholder carrying the live marker, or a blank one, is not a live value', async () => {
  const html = tipsPage((name) =>
    name === 'security' ? '<p data-live-value>  </p><p>unavailable</p>' : '<p data-live-value>unavailable</p>',
  )
  await withPage(html, async (url) => {
    const { code, stdout } = await runCheckArgs([url, TIPS_TEXT, TIPS_LIVE])
    assert.equal(code, 1)
    assert.match(stdout, /^SMOKE_RESULT=fail: live data unavailable — .*: security, price, CPI-U, valuation \(/m)
  })
})

test('a static page with no --live keeps today\'s exact pass and fail lines', async () => {
  const { server, url } = await serve('<html><body><h1>Item Board</h1></body></html>')
  try {
    const pass = await runCheckArgs([url, 'Item Board'])
    assert.equal(pass.code, 0)
    assert.equal(pass.stdout, `SMOKE_RESULT=pass — "Item Board" rendered at ${url}\n`)
    const fail = await runCheckArgs([url, 'Missing Heading'])
    assert.equal(fail.code, 1)
    assert.equal(fail.stdout, `SMOKE_RESULT=fail: locator.waitFor: Timeout 10000ms exceeded. (${url}, expected "Missing Heading")\n`)
  } finally {
    server.close()
  }
})

test('live: the homepage chart showing its declared empty state fails naming the chart (US-250)', async () => {
  const caption = 'A year of Apple (AAPL) closes, straight from the API.'
  const live = `--live=${JSON.stringify({
    path: '/',
    liveValue: '[data-live-value]',
    sections: [{ name: 'chart', selector: '#aapl-chart', emptyText: ['No data yet'] }],
  })}`
  const { server, url } = await serve(`<html><body><figure><div id="aapl-chart">No data yet</div><figcaption>${caption}</figcaption></figure></body></html>`)
  try {
    const { code, stdout } = await runCheckArgs([url, caption, live])
    assert.equal(code, 1)
    assert.match(stdout, /^SMOKE_RESULT=fail: live data unavailable — every live section shows its unavailable or empty state: chart \(/m)
  } finally {
    server.close()
  }
})

test('live: a selector Playwright would read as another engine is refused before the page loads', async () => {
  const cases = [
    [{ liveValue: '[data-live-value]', sections: [{ name: 'price', selector: "js=document.title='pwned'", emptyText: ['unavailable'] }] }, 'sections[0].selector'],
    [{ liveValue: 'xpath=//span', sections: [{ name: 'price', selector: '#price', emptyText: ['unavailable'] }] }, 'liveValue'],
  ]
  // Every request is counted: a refused marker never reaches the browser.
  let requests = 0
  const server = createServer((_req, res) => {
    requests += 1
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<html><body><p>${TIPS_TEXT}</p><span id="price" data-live-value>101.23</span></body></html>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/free/tips`
  try {
    for (const [live, field] of cases) {
      const { code, stdout } = await runCheckArgs([url, TIPS_TEXT, `--live=${JSON.stringify(live)}`])
      assert.equal(code, 1)
      assert.ok(stdout.startsWith(`SMOKE_RESULT=fail: --live ${field} is not a usable marker`), stdout)
      assert.ok(!stdout.includes('pwned') && !stdout.includes('//span'), 'the line names the field, never the value')
    }
    assert.equal(requests, 0)
  } finally {
    server.close()
  }
})
