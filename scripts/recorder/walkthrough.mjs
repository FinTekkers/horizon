import { mkdir, mkdtemp, readFile, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEVICE_SCALE_FACTOR, EMAIL_RE, VIEWPORT, launch } from './browser.mjs'
import { encodeVideo } from './encode.mjs'
import { RecorderError } from './errors.mjs'
import { checkBoard } from './walkthrough-guard.mjs'
import { MASK_INIT_SCRIPT, runAction } from './walkthrough-page.mjs'

// HZ-530: walkthrough mode. A scenario file is an ordered list of actions,
// played in real time against a local throwaway Horizon and filmed with
// recordVideo. RECORDER_WALKTHROUGH_DIR points the loader somewhere else
// (the tests use it for their stub scenarios).
export const WALKTHROUGH_DIR = fileURLToPath(new URL('./walkthroughs/', import.meta.url))
export const TEMP_PREFIX = 'hz-walkthrough-'

const NAME_RE = /^[a-z0-9-]+$/
const STRING = (v) => typeof v === 'string' && v.length > 0
const MS = (v) => Number.isInteger(v) && v >= 0
// Each action's fields and their checks. A field marked optional may be absent.
const ACTIONS = {
  goto: { path: (v) => STRING(v) && v.startsWith('/') && !v.startsWith('//') },
  click: { selector: STRING },
  type: { selector: STRING, text: STRING, delayMs: MS },
  waitFor: { selector: STRING, timeoutMs: { optional: true, check: (v) => MS(v) && v > 0 } },
  pause: { ms: MS },
  caption: { text: STRING, ms: (v) => MS(v) && v > 0 },
}

export async function loadScenario(name, dir = WALKTHROUGH_DIR) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new RecorderError(`walkthrough name must match ${NAME_RE} (a file in ${dir})`)
  const file = path.join(dir, `${name}.json`)
  let scenario
  try {
    scenario = JSON.parse(await readFile(file, 'utf8'))
  } catch (err) {
    throw new RecorderError(`walkthrough ${name}: can't read ${file}: ${err.code || err.message}`)
  }
  const bad = (why) => new RecorderError(`walkthrough ${name}: ${file}: ${why}`)
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) throw bad('expected a JSON object')
  for (const key of Object.keys(scenario)) if (key !== 'actions') throw bad(`unknown key "${key}"`)
  if (!Array.isArray(scenario.actions) || !scenario.actions.length) throw bad('"actions" must be a non-empty list')
  scenario.actions.forEach((a, i) => {
    const spec = a && typeof a === 'object' && typeof a.action === 'string' && Object.hasOwn(ACTIONS, a.action) ? ACTIONS[a.action] : null
    if (!spec) throw bad(`step ${i}: unknown action ${JSON.stringify(a?.action ?? null)}`)
    for (const key of Object.keys(a)) if (key !== 'action' && !Object.hasOwn(spec, key)) throw bad(`step ${i} (${a.action}): unknown field "${key}"`)
    for (const [key, rule] of Object.entries(spec)) {
      const check = typeof rule === 'function' ? rule : rule.check
      if (!Object.hasOwn(a, key) ? !rule.optional : !check(a[key])) throw bad(`step ${i} (${a.action}): missing or bad "${key}"`)
    }
    // Scenario files are committed: no address goes in one, not even a demo.
    if (strings(a).some((s) => EMAIL_RE.test(s))) throw bad(`step ${i} (${a.action}): holds an email address`)
  })
  return { name, actions: scenario.actions }
}

function strings(value) {
  if (typeof value === 'string') return [value]
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

// What the scenario's fixed times add up to: captions, pauses and
// human-paced typing. goto, click and waitFor take as long as the page does.
export function expectedMs(scenario) {
  let ms = 0
  for (const a of scenario.actions) {
    if (a.action === 'caption' || a.action === 'pause') ms += a.ms
    else if (a.action === 'type') ms += a.text.length * a.delayMs
  }
  return ms
}

// Loads the scenario, refuses any board that isn't a local throwaway Horizon
// (before a browser exists), plays the actions while recordVideo films the
// page, and encodes the part from the first action's start to the last
// action's end (measured, not computed) to <outDir>/<name>.mp4. Whatever
// happens, the raw .webm's temp dir is removed, and a failed run leaves no
// .mp4 or .part in <outDir>.
export async function runWalkthrough({ name, outDir, board, env = process.env, log }) {
  const scenario = await loadScenario(name, env.RECORDER_WALKTHROUGH_DIR || WALKTHROUGH_DIR)
  if (!board) throw new RecorderError('--walkthrough needs --board <url>: the UI of a local throwaway Horizon started with HORIZON_TEST_HOOKS=1')
  await checkBoard(board)
  const boardUrl = board.replace(/\/+$/, '')
  const origin = new URL(boardUrl).origin
  const mp4 = path.join(outDir, `${name}.mp4`)

  const tmp = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX))
  let browser
  let createdOut
  let ok = false
  try {
    log('launch: chromium')
    browser = await launch()
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR, serviceWorkers: 'block', recordVideo: { dir: tmp, size: VIEWPORT } })
    await context.addInitScript(MASK_INIT_SCRIPT)
    // The browser talks to the board's origin only. Anything else (fonts,
    // images, fetches) is aborted, and the log names just its host.
    await context.route('**/*', (route) => {
      const req = route.request()
      const url = new URL(req.url())
      if (url.origin === origin || url.protocol === 'data:' || url.protocol === 'blob:') return route.continue()
      log(`blocked ${req.resourceType()} to ${url.hostname}`)
      return route.abort('blockedbyclient')
    })
    const videoStart = Date.now()
    const page = await context.newPage()
    try {
      await page.goto(`${boardUrl}/`, { waitUntil: 'load' })
    } catch (err) {
      throw new RecorderError(`walkthrough ${name}: opening the board failed: ${firstLine(err)}`)
    }
    const startedAt = Date.now()
    for (const [i, action] of scenario.actions.entries()) {
      try {
        await runAction(page, action, boardUrl)
      } catch (err) {
        throw new RecorderError(`walkthrough ${name}: step ${i} (${action.action}) failed: ${firstLine(err)}`)
      }
    }
    const endedAt = Date.now()
    const video = page.video()
    await context.close()
    createdOut = await mkdir(outDir, { recursive: true })
    await encodeVideo(await video.path(), mp4, { startSec: (startedAt - videoStart) / 1000, durationSec: (endedAt - startedAt) / 1000 })
    ok = true
    log(`wrote ${mp4} (${((endedAt - startedAt) / 1000).toFixed(1)} s; the scenario's fixed times add up to ${(expectedMs(scenario) / 1000).toFixed(1)} s)`)
  } finally {
    await browser?.close()
    await rm(tmp, { recursive: true, force: true })
    if (!ok) {
      await rm(`${mp4}.part`, { force: true })
      // Only directories this run made, and only while they are empty.
      for (let dir = outDir; createdOut && dir.startsWith(createdOut); dir = path.dirname(dir)) {
        if (!(await rmdir(dir).then(() => true, () => false))) break
      }
    }
  }
}

function firstLine(err) {
  return String(err?.message ?? err).split('\n')[0]
}
