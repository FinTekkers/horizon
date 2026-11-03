import { EMAIL_RE, MASK_COLOR } from './browser.mjs'

export const CAPTION_BACKGROUND = '#0b1020'
export const CAPTION_ID = 'hz-wt-caption'
const MASK_LAYER_ID = 'hz-wt-mask'
// The same fields item mode masks (browser.mjs masksFor()), plus HZ-698's
// typeEnv targets, which runAction marks before the first keypress.
const MASK_ATTR = 'data-hz-mask'
const MASK_SELECTOR = `input[type=password],[aria-label*="PIN" i],input[type=email],[${MASK_ATTR}]`
// How often a long waitUntil says it is still waiting.
const PROGRESS_MS = 60_000

// Runs in every page and frame at document start. A walkthrough is filmed
// with recordVideo, which has no mask option, so the masks are painted in
// the page itself: solid MASK_COLOR boxes on a fixed overlay over every PIN
// or email field, every input whose value holds an address, and every
// address in visible text. The page's own DOM is never edited (React owns
// it), only the overlay, which is redrawn on every DOM change (a microtask,
// so before the next paint) and on every animation frame. A style also
// fills the PIN and email fields themselves, so they are hidden even before
// the first redraw. `pattern` is EMAIL_RE's source, plus (HZ-698) any typeEnv
// value, so a code the page echoes back as text is masked too.
function maskPage({ color, selector, layerId, captionId, pattern }) {
  const re = new RegExp(pattern, 'gi')
  const style = document.createElement('style')
  style.textContent = `${selector}{background:${color}!important;color:${color}!important;-webkit-text-fill-color:${color}!important;border-color:${color}!important;caret-color:transparent!important}`
  const layer = document.createElement('div')
  layer.id = layerId
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;contain:strict'
  const ours = (node) => layer.contains(node) || document.getElementById(captionId)?.contains(node)

  const rects = () => {
    const out = []
    for (const el of document.querySelectorAll(selector)) out.push(...el.getClientRects())
    for (const el of document.querySelectorAll('input,textarea')) {
      re.lastIndex = 0
      if (re.test(el.value)) out.push(...el.getClientRects())
    }
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (ours(node)) continue
      re.lastIndex = 0
      for (let m = re.exec(node.data); m; m = re.exec(node.data)) {
        range.setStart(node, m.index)
        range.setEnd(node, m.index + m[0].length)
        out.push(...range.getClientRects())
      }
    }
    return out
  }

  const draw = () => {
    // document.documentElement is looked up each time: document.open() replaces it.
    const root = document.documentElement
    if (!root) return
    if (style.parentNode !== root) root.appendChild(style)
    if (layer.parentNode !== root) root.appendChild(layer)
    const boxes = rects().filter((r) => r.width > 0 && r.height > 0)
    while (layer.childElementCount > boxes.length) layer.lastElementChild.remove()
    while (layer.childElementCount < boxes.length) layer.appendChild(document.createElement('div'))
    boxes.forEach((r, i) => {
      layer.children[i].style.cssText = `position:absolute;background:${color};left:${r.left - 2}px;top:${r.top - 2}px;width:${r.width + 4}px;height:${r.height + 4}px`
    })
  }

  // Changes to the overlay itself are ignored, or every redraw would queue another.
  new MutationObserver((records) => {
    if (records.some((r) => !layer.contains(r.target) && r.target !== layer)) draw()
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
  document.addEventListener('input', draw, true)
  const tick = () => {
    draw()
    requestAnimationFrame(tick)
  }
  tick()
}

// The mask script, masking `values` (HZ-698: the typeEnv values) wherever
// they show, as well as addresses.
export function maskValuesScript(values = []) {
  const pattern = [EMAIL_RE.source, ...values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))].join('|')
  return `(${maskPage})(${JSON.stringify({ color: MASK_COLOR, selector: MASK_SELECTOR, layerId: MASK_LAYER_ID, captionId: CAPTION_ID, pattern })})`
}

export const MASK_INIT_SCRIPT = maskValuesScript()

// One scenario action. `goto` paths are relative to the board; the scenario
// loader has already checked every field. HZ-698: `env` holds the values
// typeEnv may read, `log` takes waitUntil's progress lines, `stopIf(page)`
// returning a reason ends a waitUntil early, and `resumeUrl` is where the
// previous scene of the run ended. No value typed is ever logged.
export async function runAction(page, action, boardUrl, { env = {}, log = () => {}, stopIf = async () => null, resumeUrl = null } = {}) {
  switch (action.action) {
    case 'goto':
      await page.goto(new URL(action.path.replace(/^\//, ''), `${boardUrl}/`).href, { waitUntil: 'load' })
      return
    case 'followLink': {
      const href = await page.locator(action.selector).first().getAttribute('href')
      if (!href) throw new Error(`no link at ${action.selector}`)
      const target = new URL(href, page.url())
      if (target.origin !== new URL(boardUrl).origin) throw new Error('followLink opens same-origin links only')
      await page.goto(target.href, { waitUntil: 'load' })
      return
    }
    case 'gotoSite':
      // The loader allows only SITE_URL_PREFIXES (the tenant's live site).
      await page.goto(action.url, { waitUntil: 'load' })
      return
    case 'click':
      await page.locator(action.selector).first().click()
      return
    case 'type':
      await page.locator(action.selector).first().pressSequentially(action.text, { delay: action.delayMs })
      return
    case 'waitFor':
      await page.locator(action.selector).first().waitFor({ state: 'visible', timeout: action.timeoutMs ?? 10000 })
      return
    case 'waitUntil':
      await waitUntil(page, action, { log, stopIf })
      return
    case 'resume':
      if (!resumeUrl) throw new Error('resume needs the previous scene in the same run (e.g. --chapter)')
      await page.goto(resumeUrl, { waitUntil: 'load' })
      return
    case 'typeEnv': {
      const value = Object.hasOwn(env, action.env) ? env[action.env] : ''
      if (typeof value !== 'string' || !value) throw new Error(`${action.env} is unset`)
      const field = page.locator(action.selector).first()
      // Masked before the first key, so no prefix of the value is ever filmed.
      await field.evaluate((el, attr) => el.setAttribute(attr, ''), MASK_ATTR)
      await field.pressSequentially(value, { delay: action.delayMs })
      return
    }
    case 'pause':
      await page.waitForTimeout(action.ms)
      return
    case 'caption':
      await showCaption(page, action.text, action.ms)
      return
    default:
      throw new Error(`unknown action ${action.action}`)
  }
}

// HZ-698: a long, real wait (a gate card, a deploy). The page stays open and
// filmed throughout; the selector is checked every second, the page is
// reloaded every reloadEveryMs if set, and a line is logged every minute.
async function waitUntil(page, { selector, timeoutMs, reloadEveryMs }, { log, stopIf }) {
  const started = Date.now()
  const secs = (ms) => Math.round(ms / 1000)
  const target = page.locator(selector).first()
  let nextReload = reloadEveryMs ? started + reloadEveryMs : Infinity
  let nextNote = started + PROGRESS_MS
  log(`waiting for ${selector} (up to ${secs(timeoutMs)} s)`)
  for (;;) {
    if (await target.isVisible().catch(() => false)) {
      log(`found ${selector} after ${secs(Date.now() - started)} s`)
      return
    }
    const reason = await stopIf(page)
    if (reason) throw new Error(reason)
    const now = Date.now()
    if (now - started >= timeoutMs) throw new Error(`timeout after ${secs(timeoutMs)} s waiting for ${selector}`)
    if (now >= nextNote) {
      log(`still waiting for ${selector} (${Math.floor((now - started) / 60_000)} min)`)
      nextNote += PROGRESS_MS
    }
    if (now >= nextReload) {
      await page.reload({ waitUntil: 'load' }).catch(() => {})
      nextReload = Date.now() + reloadEveryMs
    }
    await page.waitForTimeout(Math.min(1000, started + timeoutMs - now))
  }
}

// A full-screen title card for `ms`, in renderCard()'s look. It sits above
// the mask overlay and is opaque, so nothing under it shows. The text is set
// with textContent, never parsed as HTML.
export async function showCaption(page, text, ms) {
  await page.evaluate(({ id, text, background }) => {
    const card = document.createElement('div')
    card.id = id
    card.style.cssText = `position:fixed;inset:0;z-index:2147483647;background:${background};color:#fff;display:flex;align-items:center;justify-content:center;padding:0 120px;font:600 44px/1.3 sans-serif;text-align:center`
    card.textContent = text
    document.documentElement.appendChild(card)
  }, { id: CAPTION_ID, text, background: CAPTION_BACKGROUND })
  await page.waitForTimeout(ms)
  await page.evaluate((id) => document.getElementById(id)?.remove(), CAPTION_ID)
}
