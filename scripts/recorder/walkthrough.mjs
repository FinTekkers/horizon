import { mkdir, mkdtemp, readFile, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEVICE_SCALE_FACTOR, EMAIL_RE, VIEWPORT, launch, showsLogin } from './browser.mjs'
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
// HZ-665: the throwaway board's login. A hooks-on server treats a request
// carrying its SCREENSHOT_LOGIN_KEY in this header as the admin user, but
// never as a session, so it cannot pass a gate. The same name as
// server/src/testEnvLogin.js's TEST_ENV_LOGIN_HEADER, copied rather than
// imported: that module loads the server's config. Never log the value.
export const TEST_ENV_LOGIN_HEADER = 'x-horizon-test-env-screenshot-login-key'
// What the board shows once /api/auth/me has answered: the login page's
// Sign in button, or the logged-in app shell (ui/src/App.jsx).
const LOGIN_OR_APP = 'button:has-text("Sign in"), .app'
const LOGIN_WAIT_MS = 10000

// Uppercase too, for HZ-698's scene ids (A1.json … C7.json).
const NAME_RE = /^[A-Za-z0-9-]+$/
const STRING = (v) => typeof v === 'string' && v.length > 0
const MS = (v) => Number.isInteger(v) && v >= 0
// HZ-698: the only environment variables a typeEnv step may type. Their
// values are read at run time and never written to a file, log or frame.
export const ENV_ALLOWLIST = ['SHOREWARD_PROMO_CODE', 'SHOREWARD_TENANT_EMAIL']
// waitFor is for a screen that is a click away (10 s by default); waitUntil
// is for real waits of minutes or hours, logged as they go, up to 4 h.
export const WAIT_UNTIL_MAX_MS = 4 * 60 * 60 * 1000
// Each action's fields and their checks. A field marked optional may be absent.
const ACTIONS = {
  goto: { path: (v) => STRING(v) && v.startsWith('/') && !v.startsWith('//') },
  click: { selector: STRING },
  type: { selector: STRING, text: STRING, delayMs: MS },
  waitFor: { selector: STRING, timeoutMs: { optional: true, check: (v) => MS(v) && v > 0 } },
  pause: { ms: MS },
  caption: { text: STRING, ms: (v) => MS(v) && v > 0 },
  waitUntil: {
    selector: STRING,
    timeoutMs: (v) => MS(v) && v > 0 && v <= WAIT_UNTIL_MAX_MS,
    reloadEveryMs: { optional: true, check: (v) => MS(v) && v >= 30_000 },
  },
  typeEnv: { selector: STRING, env: (v) => ENV_ALLOWLIST.includes(v), delayMs: MS },
  // Opens the page the previous scene of the same production run ended on.
  resume: {},
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
  for (const key of Object.keys(scenario)) if (key !== 'actions' && key !== 'setup') throw bad(`unknown key "${key}"`)
  if (!Array.isArray(scenario.actions) || !scenario.actions.length) throw bad('"actions" must be a non-empty list')
  // HZ-698: "setup" steps play before filming starts (e.g. getting back to
  // a checkout form a new browser launch doesn't have). They are checked
  // like actions, and named "setup <i>" in errors.
  if (Object.hasOwn(scenario, 'setup') && (!Array.isArray(scenario.setup) || !scenario.setup.length)) throw bad('"setup", if given, must be a non-empty list')
  const check = (list, step) => list.forEach((a, i) => {
    const spec = a && typeof a === 'object' && typeof a.action === 'string' && Object.hasOwn(ACTIONS, a.action) ? ACTIONS[a.action] : null
    if (!spec) throw bad(`${step} ${i}: unknown action ${JSON.stringify(a?.action ?? null)}`)
    for (const key of Object.keys(a)) if (key !== 'action' && !Object.hasOwn(spec, key)) throw bad(`${step} ${i} (${a.action}): unknown field "${key}"`)
    for (const [key, rule] of Object.entries(spec)) {
      const ok = typeof rule === 'function' ? rule : rule.check
      if (!Object.hasOwn(a, key) ? !rule.optional : !ok(a[key])) throw bad(`${step} ${i} (${a.action}): missing or bad "${key}"`)
    }
    // Scenario files are committed: no address goes in one, not even a demo.
    if (strings(a).some((s) => EMAIL_RE.test(s))) throw bad(`${step} ${i} (${a.action}): holds an email address`)
  })
  check(scenario.setup ?? [], 'setup')
  check(scenario.actions, 'step')
  return { name, setup: scenario.setup ?? [], actions: scenario.actions }
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
// (before a browser exists), and films it with recordScene().
export async function runWalkthrough({ name, outDir, board, env = process.env, log }) {
  const scenario = await loadScenario(name, env.RECORDER_WALKTHROUGH_DIR || WALKTHROUGH_DIR)
  if (!board) throw new RecorderError('--walkthrough needs --board <url>: the UI of a local throwaway Horizon started with HORIZON_TEST_HOOKS=1')
  await checkBoard(board)
  const boardUrl = board.replace(/\/+$/, '')
  const origin = new URL(boardUrl).origin
  const loginKey = env.SCREENSHOT_LOGIN_KEY || ''

  const { ms } = await recordScene({
    label: `walkthrough ${name}`,
    name,
    setup: scenario.setup,
    actions: scenario.actions,
    outDir,
    baseUrl: boardUrl,
    open: async (videoDir, defer) => {
      log('launch: chromium')
      const browser = await launch()
      defer(() => browser.close())
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR, serviceWorkers: 'block', recordVideo: { dir: videoDir, size: VIEWPORT } })
      await context.addInitScript(MASK_INIT_SCRIPT)
      // The browser talks to the board's origin only. Anything else (fonts,
      // images, fetches) is aborted, and the log names just its host. The
      // login key goes to the board's origin only, so no other host sees it.
      await context.route('**/*', (route) => {
        const req = route.request()
        const url = new URL(req.url())
        if (url.origin === origin && loginKey) return route.continue({ headers: { ...req.headers(), [TEST_ENV_LOGIN_HEADER]: loginKey } })
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
      // The UI draws Sign in only once /api/auth/me has answered 401, after
      // load, so wait for it or the app shell before deciding. A board that
      // shows neither is left to the scenario's own first step.
      await page.locator(LOGIN_OR_APP).first().waitFor({ state: 'visible', timeout: LOGIN_WAIT_MS }).catch(() => {})
      if (await showsLogin(page)) {
        throw new RecorderError(`walkthrough ${name}: the board showed the login screen: export SCREENSHOT_LOGIN_KEY with the key the board's server was started with (scripts/recorder/README.md)`)
      }
      return { page, videoStart }
    },
  })
  log(`wrote ${path.join(outDir, `${name}.mp4`)} (${(ms / 1000).toFixed(1)} s; the scenario's fixed times add up to ${(expectedMs(scenario) / 1000).toFixed(1)} s)`)
}

// Films one scene, for walkthrough mode and HZ-698's production mode alike.
// open(videoDir, defer) starts a recordVideo context filming into videoDir,
// registers its cleanup with defer(fn), and returns the page and the time
// just before that page was made. The setup steps play, then the actions in
// real time, and the part from the first action's start to the last
// action's end (measured, not computed) is encoded to <outDir>/<name>.mp4 at
// `size`. Returns that span in ms and the URL the page ended on (kept in
// memory for a later scene's resume, never logged). Whatever happens, the
// raw .webm's temp dir is removed, and a failed run leaves no .mp4 or .part
// in <outDir>. A failed step throws "<label>: step <i> (<action>) failed:
// <reason>" ("setup <i>" for a setup step).
export async function recordScene({ label, name, setup = [], actions, outDir, baseUrl, open, size, actionOpts, onStep = () => {} }) {
  const mp4 = path.join(outDir, `${name}.mp4`)
  const tmp = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX))
  const cleanups = []
  let createdOut
  let ok = false
  try {
    const { page, videoStart } = await open(tmp, (fn) => cleanups.push(fn))
    const play = async (list, step) => {
      for (const [i, action] of list.entries()) {
        onStep(i, action, step)
        try {
          await runAction(page, action, baseUrl, actionOpts)
        } catch (err) {
          throw new RecorderError(`${label}: ${step} ${i} (${action.action}) failed: ${firstLine(err)}`)
        }
      }
    }
    await play(setup, 'setup')
    const startedAt = Date.now()
    await play(actions, 'step')
    const endedAt = Date.now()
    const url = page.url()
    const video = page.video()
    await page.context().close()
    createdOut = await mkdir(outDir, { recursive: true })
    await encodeVideo(await video.path(), mp4, { startSec: (startedAt - videoStart) / 1000, durationSec: (endedAt - startedAt) / 1000, size })
    ok = true
    return { ms: endedAt - startedAt, url }
  } finally {
    for (const fn of cleanups.reverse()) await fn()
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

export function firstLine(err) {
  return String(err?.message ?? err).split('\n')[0]
}
