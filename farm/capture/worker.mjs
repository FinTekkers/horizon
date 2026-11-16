// HZ-506: the farm's screenshot capture worker. farm/screenshot_runner.py
// starts it, owns every timeout and kills it on overrun — nothing here waits
// with a deadline of its own.
//
// Protocol, newline-delimited JSON:
//   out, once at start:  {"ready": true}  (or {"ready": false, "error": "..."})
//   in, one per shot:    {"url", "width", "height", "theme", "maxHeightPx", "png", "headers",
//                         "waitFor"?, "mask"?: [selector], "cookies"?: [{"name", "value"}],
//                         "html"?, "csp"?, "blockExternal"?: bool, "consoleErrors"?: bool}
//   out, one per shot:   {"ok": true, "clipped": bool, "heightPx": n}
//                        {"ok": false, "error": "..."}
//                        (HZ-557: `mask "<sel>" matched nothing`, `mask "<sel>" still visible`)
//                        HO-862: plus "blocked": [url] with blockExternal and
//                        "consoleErrors": [text] with consoleErrors, on either reply
//
// `headers` are sent only to the shot's own origin, so a test key never
// reaches a third-party host the page loads. Nothing here logs in: the page
// at `url` is the only one visited.
//
// HZ-527: after `load` the shot waits for network idle — no request in flight
// for QUIET_MS — then, when `waitFor` is set, for that selector to be
// visible. Idle ignores EventSource and WebSocket requests, which never end,
// so a page with a live stream still settles. Neither wait has a deadline.
//
// HZ-557: `cookies` are set for the shot's own origin before the page loads.
// Browser cookies ignore the port, so a request to another origin on the same
// host is re-fetched here without its Cookie header and fulfilled from that
// (buffered: a stream there never ends). Never echo `cookies`: they are the
// repo's test-login values.
// `mask` selectors are covered in MASK_COLOR by Playwright. A selector with no
// match that has a box fails the shot; so does a masked box that is not solid
// MASK_COLOR in the shot. The shot is taken to a buffer and checked first, so
// an unmasked element never reaches disk.
//
// HO-862 (farm/visual_page.py), every field optional — a shot without them
// is captured exactly as before:
//   `html` — the shot's `url` is answered with this body (and `csp` as its
//     Content-Security-Policy header) instead of being fetched, so the page
//     runs under the CSP owners get and its fixed host is never resolved.
//   `blockExternal` — every other request is aborted and its URL recorded in
//     `blocked` (data: and blob: never reach the network). Without `html`,
//     only requests to the shot's own origin go through.
//   `consoleErrors` — console errors, uncaught exceptions and CSP violations
//     are recorded in `consoleErrors`.
// Both lists hold at most LIST_MAX entries of ENTRY_MAX chars. A page shot
// never carries `headers` or `cookies` (its only route is the one above).
import { writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import { MASK_COLOR, leakedBox } from './mask.mjs'

const COLOR_SCHEMES = new Set(['light', 'dark'])
const QUIET_MS = 500
const POLL_MS = 50
const LONG_LIVED = new Set(['eventsource', 'websocket'])
// What a re-fetch must not copy: the cookies it exists to drop, and what
// fetch sets itself (or decodes, for content-encoding).
const REFETCH_DROP = new Set(['cookie', 'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length', 'expect'])
const REPLY_DROP = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive'])
const LIST_MAX = 10
const ENTRY_MAX = 200

function reply(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

// Tracks the page's in-flight requests from before navigation starts.
// waitForIdle() resolves once none is in flight and none has started or
// ended for QUIET_MS.
function trackRequests(page) {
  const inFlight = new Set()
  let lastChange = Date.now()
  const done = (request) => {
    if (inFlight.delete(request)) lastChange = Date.now()
  }
  page.on('request', (request) => {
    if (LONG_LIVED.has(request.resourceType())) return
    inFlight.add(request)
    lastChange = Date.now()
  })
  page.on('requestfinished', done)
  page.on('requestfailed', done)
  return {
    async waitForIdle() {
      while (inFlight.size || Date.now() - lastChange < QUIET_MS) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      }
    },
  }
}

// A request to another port on the app's host, sent without cookies.
async function refetchWithoutCookies(route) {
  const request = route.request()
  const headers = {}
  for (const [name, value] of Object.entries(await request.allHeaders())) {
    if (!REFETCH_DROP.has(name) && !name.startsWith(':')) headers[name] = value
  }
  let res
  let body
  try {
    res = await fetch(request.url(), {
      method: request.method(),
      headers,
      body: request.postDataBuffer() ?? undefined,
      redirect: 'manual',
    })
    body = Buffer.from(await res.arrayBuffer())
  } catch {
    return route.abort()
  }
  const reply = {}
  res.headers.forEach((value, name) => {
    if (!REPLY_DROP.has(name)) reply[name] = value
  })
  return route.fulfill({ status: res.status, headers: reply, body })
}

// Each selector's matches as page-space boxes; a match with no area (e.g.
// display:none) has none. Fails on the first selector left with no box.
async function maskBoxes(page, selectors) {
  const boxes = []
  for (const sel of selectors) {
    const found = await page.locator(sel).evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect()
        return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height }
      }),
    )
    const real = found.filter((box) => box.width > 0 && box.height > 0)
    if (!real.length) return { error: `mask ${JSON.stringify(sel)} matched nothing` }
    for (const box of real) boxes.push({ sel, ...box })
  }
  return { boxes }
}

function pushCapped(list, text) {
  if (list.length < LIST_MAX) list.push(String(text).split('\n')[0].slice(0, ENTRY_MAX))
}

// HO-862: the page shot's one route — its own URL from `html`, every other
// request aborted and recorded when blockExternal is set.
async function routePage(context, shot, blocked) {
  const own = new URL(shot.url)
  await context.route('**/*', (route) => {
    const url = route.request().url()
    if (typeof shot.html === 'string' && url === own.href) {
      const headers = { 'content-type': 'text/html; charset=utf-8' }
      if (typeof shot.csp === 'string' && shot.csp) headers['content-security-policy'] = shot.csp
      return route.fulfill({ status: 200, headers, body: shot.html })
    }
    if (!shot.blockExternal) return route.continue()
    if (typeof shot.html !== 'string' && new URL(url).origin === own.origin) return route.continue()
    pushCapped(blocked, url)
    return route.abort('blockedbyclient')
  })
}

async function capture(browser, shot) {
  const extra = {}
  const blocked = []
  const errors = []
  if (shot.blockExternal) extra.blocked = blocked
  if (shot.consoleErrors) extra.consoleErrors = errors
  const result = await captureShot(browser, shot, blocked, errors)
  return { ...result, ...extra }
}

async function captureShot(browser, shot, blocked, errors) {
  const context = await browser.newContext({
    viewport: { width: shot.width, height: shot.height },
    deviceScaleFactor: 1,
    colorScheme: COLOR_SCHEMES.has(shot.theme) ? shot.theme : 'no-preference',
  })
  try {
    if (!COLOR_SCHEMES.has(shot.theme)) {
      await context.addInitScript((theme) => {
        document.documentElement.dataset.theme = theme
      }, shot.theme)
    }
    const pageShot = typeof shot.html === 'string' || shot.blockExternal === true
    if (pageShot) await routePage(context, shot, blocked)
    const headers = pageShot ? {} : shot.headers || {}
    if (Object.keys(headers).length) {
      const origin = new URL(shot.url).origin
      await context.route('**/*', (route) => {
        const request = route.request()
        if (new URL(request.url()).origin !== origin) return route.continue()
        return route.continue({ headers: { ...request.headers(), ...headers } })
      })
    }
    const cookies = pageShot ? [] : shot.cookies || []
    if (cookies.length) {
      const app = new URL(shot.url)
      await context.addCookies(cookies.map(({ name, value }) => ({ name, value, url: app.origin })))
      await context.route((url) => url.hostname === app.hostname && url.origin !== app.origin, refetchWithoutCookies)
    }
    const page = await context.newPage()
    if (shot.consoleErrors) {
      page.on('console', (msg) => {
        if (msg.type() === 'error') pushCapped(errors, msg.text())
      })
      page.on('pageerror', (err) => pushCapped(errors, err && err.message ? err.message : err))
    }
    const network = trackRequests(page)
    await page.goto(shot.url, { waitUntil: 'load', timeout: 0 })
    await network.waitForIdle()
    if (shot.waitFor) {
      await page.locator(shot.waitFor).first().waitFor({ state: 'visible', timeout: 0 })
    }
    const scrollHeight = await page.evaluate(() =>
      Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
    )
    const heightPx = Math.max(1, Math.min(scrollHeight, shot.maxHeightPx))
    const options = { fullPage: true, timeout: 0, clip: { x: 0, y: 0, width: shot.width, height: heightPx } }
    const selectors = shot.mask || []
    if (!selectors.length) {
      await page.screenshot({ ...options, path: shot.png })
    } else {
      const { boxes, error } = await maskBoxes(page, selectors)
      if (error) return { ok: false, error }
      const mask = selectors.map((sel) => page.locator(sel))
      const buffer = await page.screenshot({ ...options, mask, maskColor: MASK_COLOR })
      const leaked = leakedBox(PNG.sync.read(buffer), boxes)
      if (leaked >= 0) return { ok: false, error: `mask ${JSON.stringify(boxes[leaked].sel)} still visible` }
      await writeFile(shot.png, buffer)
    }
    return { ok: true, clipped: scrollHeight > shot.maxHeightPx, heightPx }
  } finally {
    await context.close().catch(() => {})
  }
}

async function main() {
  let browser
  try {
    browser = await chromium.launch()
  } catch (err) {
    reply({ ready: false, error: String(err && err.message ? err.message : err).split('\n')[0] })
    process.exit(1)
  }
  reply({ ready: true })
  const lines = createInterface({ input: process.stdin })
  for await (const line of lines) {
    if (!line.trim()) continue
    try {
      reply(await capture(browser, JSON.parse(line)))
    } catch (err) {
      reply({ ok: false, error: String(err && err.message ? err.message : err).split('\n')[0] })
    }
  }
  await browser.close()
}

main()
