import { EMAIL_RE, MASK_COLOR } from './browser.mjs'

export const CAPTION_BACKGROUND = '#0b1020'
export const CAPTION_ID = 'hz-wt-caption'
const MASK_LAYER_ID = 'hz-wt-mask'
// The same fields item mode masks (browser.mjs masksFor()).
const MASK_SELECTOR = 'input[type=password],[aria-label*="PIN" i],input[type=email]'

// Runs in every page and frame at document start. A walkthrough is filmed
// with recordVideo, which has no mask option, so the masks are painted in
// the page itself: solid MASK_COLOR boxes on a fixed overlay over every PIN
// or email field, every input whose value holds an address, and every
// address in visible text. The page's own DOM is never edited (React owns
// it), only the overlay, which is redrawn on every DOM change (a microtask,
// so before the next paint) and on every animation frame. A style also
// fills the PIN and email fields themselves, so they are hidden even before
// the first redraw.
function maskPage({ color, selector, layerId, captionId, email }) {
  const re = new RegExp(email, 'g')
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

export const MASK_INIT_SCRIPT = `(${maskPage})(${JSON.stringify({ color: MASK_COLOR, selector: MASK_SELECTOR, layerId: MASK_LAYER_ID, captionId: CAPTION_ID, email: EMAIL_RE.source })})`

// One scenario action. `goto` paths are relative to the board; the scenario
// loader has already checked every field.
export async function runAction(page, action, boardUrl) {
  switch (action.action) {
    case 'goto':
      await page.goto(new URL(action.path.replace(/^\//, ''), `${boardUrl}/`).href, { waitUntil: 'load' })
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
