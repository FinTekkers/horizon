import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

export const VIEWPORT = { width: 1280, height: 720 }
export const DEVICE_SCALE_FACTOR = 1
export const MASK_COLOR = '#000000'
// Any address in visible text. The element holding it is masked whole.
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/

// Tracing and recordVideo stay off in every context: both would write
// unmasked pixels (or request headers) to disk.
const CONTEXT_OPTIONS = { viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR, serviceWorkers: 'block' }

export function launch() {
  return chromium.launch({ headless: true })
}

// Opens <boardUrl>/<itemId> read-only. Every non-GET request, to any origin,
// is aborted, so no gate click, form or POST ever leaves the browser. GETs to
// the board's origin carry the Bearer token (EventSource included, since the
// header is added here and not by page code); other origins never see it.
// /api/auth/me is session-only on the server, so it is answered here: the UI
// only reads user.name from it, and real data still goes to the server under
// the token's own limits.
export async function openBoard(browser, { boardUrl, itemId, token }) {
  const board = new URL(boardUrl.endsWith('/') ? boardUrl : `${boardUrl}/`)
  const authMe = `${board.pathname}api/auth/me`
  const context = await browser.newContext(CONTEXT_OPTIONS)
  await context.route('**/*', (route) => {
    const req = route.request()
    if (req.method() !== 'GET') return blockWrite(route)
    const url = new URL(req.url())
    if (url.origin !== board.origin) return route.continue()
    if (url.pathname === authMe) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { name: 'recorder' } }) })
    }
    return route.continue({ headers: { ...req.headers(), authorization: `Bearer ${token}` } })
  })
  const page = await context.newPage()
  await page.goto(new URL(encodeURIComponent(itemId), board).href, { waitUntil: 'load' })
  return { page, close: () => context.close() }
}

// A blocked fetch fails; a blocked form submit gets a local 204, which tells
// Chromium to stay on the page instead of swapping the board for an error page.
function blockWrite(route) {
  return route.request().isNavigationRequest() ? route.fulfill({ status: 204, body: '' }) : route.abort('blockedbyclient')
}

export async function showsLogin(page) {
  return (await page.getByRole('button', { name: /sign in/i }).count()) > 0
}

function masksFor(page) {
  return [
    page.locator('input[type=password]'),
    page.locator('[aria-label*="PIN" i]'),
    page.locator('input[type=email]'),
    page.getByText(EMAIL_RE),
  ]
}

// The mask is painted inside the screenshot call, before the PNG exists, so
// no unmasked frame ever reaches disk.
export async function captureFrame(page, file, { fullPage = false } = {}) {
  const png = await page.screenshot({ path: file, fullPage, mask: masksFor(page), maskColor: MASK_COLOR, animations: 'disabled', caret: 'hide' })
  return { hash: createHash('sha256').update(png).digest('hex') }
}

// A full-page shot of the --site URL in its own context: no route adds the
// token there, so the site never sees it. Non-GETs are still blocked.
export async function shootSite(browser, url, file) {
  const context = await browser.newContext(CONTEXT_OPTIONS)
  try {
    await context.route('**/*', (route) => (route.request().method() === 'GET' ? route.continue() : blockWrite(route)))
    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'load' })
    await captureFrame(page, file, { fullPage: true })
  } finally {
    await context.close()
  }
}

// A 1280×720 caption card drawn over an already-masked frame. Chromium does
// the text, so ffmpeg's drawtext fonts don't matter. The page has no network.
export async function renderCard(browser, { background, caption, file }) {
  const img = (await readFile(background)).toString('base64')
  const context = await browser.newContext(CONTEXT_OPTIONS)
  try {
    await context.route('**/*', (route) => route.abort('blockedbyclient'))
    const page = await context.newPage()
    await page.setContent(`<!doctype html><html><body style="margin:0;width:1280px;height:720px;background:#0b1020;position:relative;overflow:hidden;font-family:sans-serif">
<img src="data:image/png;base64,${img}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:.35">
<div style="position:absolute;left:80px;right:80px;bottom:90px;padding:28px 36px;background:rgba(11,16,32,.85);color:#fff;font-size:44px;font-weight:600;border-radius:14px;text-align:center"></div>
</body></html>`)
    await page.locator('div').evaluate((el, text) => { el.textContent = text }, caption)
    await page.screenshot({ path: file })
  } finally {
    await context.close()
  }
}
