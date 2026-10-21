// HZ-506: the farm's screenshot capture worker. farm/screenshot_runner.py
// starts it, owns every timeout and kills it on overrun — nothing here waits
// with a deadline of its own.
//
// Protocol, newline-delimited JSON:
//   out, once at start:  {"ready": true}  (or {"ready": false, "error": "..."})
//   in, one per shot:    {"url", "width", "height", "theme", "maxHeightPx", "png", "headers",
//                         "waitFor"?}
//   out, one per shot:   {"ok": true, "clipped": bool, "heightPx": n}
//                        {"ok": false, "error": "..."}
//
// `headers` are sent only to the shot's own origin, so a test key never
// reaches a third-party host the page loads. Nothing here logs in: the page
// at `url` is the only one visited.
//
// HZ-527: after `load` the shot waits for network idle — no request in flight
// for QUIET_MS — then, when `waitFor` is set, for that selector to be
// visible. Idle ignores EventSource and WebSocket requests, which never end,
// so a page with a live stream still settles. Neither wait has a deadline.
import { createInterface } from 'node:readline'
import { chromium } from 'playwright'

const COLOR_SCHEMES = new Set(['light', 'dark'])
const QUIET_MS = 500
const POLL_MS = 50
const LONG_LIVED = new Set(['eventsource', 'websocket'])

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

async function capture(browser, shot) {
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
    const headers = shot.headers || {}
    if (Object.keys(headers).length) {
      const origin = new URL(shot.url).origin
      await context.route('**/*', (route) => {
        const request = route.request()
        if (new URL(request.url()).origin !== origin) return route.continue()
        return route.continue({ headers: { ...request.headers(), ...headers } })
      })
    }
    const page = await context.newPage()
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
    await page.screenshot({
      path: shot.png,
      fullPage: true,
      timeout: 0,
      clip: { x: 0, y: 0, width: shot.width, height: heightPx },
    })
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
