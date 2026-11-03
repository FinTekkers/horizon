import { mkdir, open, readdir, statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROD_VIEWPORT, launchProfile } from './browser.mjs'
import { RecorderError } from './errors.mjs'
import { checkProfile } from './profile.mjs'
import { LIVE_PORT, parseLoopback } from './walkthrough-guard.mjs'
import { maskValuesScript } from './walkthrough-page.mjs'
import { ENV_ALLOWLIST, firstLine, loadScenario, recordScene } from './walkthrough.mjs'

// HZ-698: production mode. Plays the Shoreward video's scenes (one JSON file
// per scene in walkthroughs/shoreward/) against the real site, signed in as
// the Parvati Real Estate tenant through a saved --profile, and films each
// scene to <out>/<scene>.mp4 at 1920×1080 in real time. <out>/run.log gets a
// timestamped line per step. No request is routed or rewritten: the
// throwaway board's login header is never sent. RECORDER_SCENE_DIR points
// the loader somewhere else (the tests use it for their stub scenes).
export const SCENE_DIR = fileURLToPath(new URL('./walkthroughs/shoreward/', import.meta.url))
export const SCENES = ['A', 'B', 'C'].flatMap((ch) => [1, 2, 3, 4, 5, 6, 7].map((n) => `${ch}${n}`))
export const PRODUCTION_URL = 'https://shoreward.ai'
const SCENE_RE = /^[A-Z][0-9]+$/
const CHAPTER_RE = /^[A-Z]$/
// A scene that may wait this long gets a free-space check first: a 2 h raw
// .webm is large.
const LONG_WAIT_MS = 30 * 60 * 1000
const MIN_FREE_BYTES = 5 * 1024 ** 3
const GOOGLE_HOST = 'accounts.google.com'
const GOOGLE_SIGN_IN = 'input[type=password], #identifierId'

function refuse(reason) {
  throw new RecorderError(`production refused --production: ${reason}`)
}

// Only https://shoreward.ai, or a loopback URL with the same rules as the
// walkthrough guard (and never port 3001), is filmed.
export function checkBaseUrl(url) {
  if (url === PRODUCTION_URL || url === `${PRODUCTION_URL}/`) return PRODUCTION_URL
  const port = parseLoopback(url)
  if (port === null) refuse(`it must be ${PRODUCTION_URL}, or http://127.0.0.1:<port> or http://localhost:<port> for a local test`)
  if (port === LIVE_PORT) refuse(`port ${LIVE_PORT} is the live horizon-server`)
  return url.replace(/\/+$/, '')
}

// The scene ids to run: --scene's comma-separated ids in that order, or
// every <chapter><n>.json in the scene dir, in number order.
export async function listScenes({ scene, chapter, dir = SCENE_DIR }) {
  if ((scene === undefined) === (chapter === undefined)) throw new RecorderError('--production needs exactly one of --scene <id>[,<id>…] or --chapter <letter>')
  if (scene !== undefined) {
    const ids = scene.split(',')
    if (!ids.every((id) => SCENE_RE.test(id))) throw new RecorderError('--scene takes ids like A1, or A3,A4')
    return ids
  }
  if (!CHAPTER_RE.test(chapter)) throw new RecorderError('--chapter must be one capital letter, e.g. A')
  const ids = (await readdir(dir).catch(() => []))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .filter((id) => SCENE_RE.test(id) && id[0] === chapter)
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
  if (!ids.length) throw new RecorderError(`no scenes in chapter ${chapter}`)
  return ids
}

// Free bytes on the filesystem holding `p` (or its nearest existing parent).
async function freeBytes(p) {
  for (let dir = path.resolve(p); ; dir = path.dirname(dir)) {
    const st = await statfs(dir).catch(() => null)
    if (st) return st.bavail * st.bsize
    if (path.dirname(dir) === dir) return Infinity
  }
}

// Everything that can fail without a browser, checked for every scene
// before the first one starts: the scene files, their typeEnv variables and,
// for long waits, free space. Returns the loaded scenes.
async function preflight({ ids, dir, env, outDir }) {
  const scenes = []
  for (const id of ids) {
    const scenario = await loadScenario(id, dir)
    const all = [...scenario.setup, ...scenario.actions]
    const vars = [...new Set(all.filter((a) => a.action === 'typeEnv').map((a) => a.env))]
    for (const name of vars) {
      if (!Object.hasOwn(env, name) || !env[name]) throw new RecorderError(`${id}: ${name} is unset (load /etc/horizon/recorder.env first: scripts/recorder/README.md)`)
    }
    const waitMs = all.filter((a) => a.action === 'waitUntil').reduce((sum, a) => sum + a.timeoutMs, 0)
    if (waitMs > LONG_WAIT_MS) {
      for (const [what, where] of [['the temp dir', tmpdir()], ['--out', outDir]]) {
        if ((await freeBytes(where)) < MIN_FREE_BYTES) throw new RecorderError(`${id}: waits up to ${Math.round(waitMs / 60000)} min, and ${what} has under 5 GB free`)
      }
    }
    scenes.push({ id, setup: scenario.setup, actions: scenario.actions, values: vars.map((n) => env[n]) })
  }
  return scenes
}

// A run log line holds an origin or a path, never a query string.
function where(url, baseOrigin) {
  try {
    const u = new URL(url)
    return u.origin === baseOrigin ? u.pathname : u.origin
  } catch {
    return 'an unparsable URL'
  }
}

function stepLine(i, a, step) {
  const target = a.selector ?? (a.path ? a.path.split(/[?#]/)[0] : a.url ?? '')
  return `${step} ${i} ${a.action}${target ? ` ${target}` : ''}${a.action === 'typeEnv' ? ` from ${a.env}` : ''}`
}

// Plays each scene in order, one browser launch per scene, and stops at the
// first failure (later scenes build on earlier ones). Every log line goes to
// <outDir>/run.log with a timestamp, and to `log`; any secret (a typeEnv
// value, the profile path) is replaced before it is written anywhere.
export async function runProduction({ ids, baseUrl, profile, outDir, headed = false, env = process.env, log }) {
  const base = checkBaseUrl(baseUrl)
  const dir = env.RECORDER_SCENE_DIR || SCENE_DIR
  const scenes = await preflight({ ids, dir, env, outDir })
  const profileDir = await checkProfile(profile)

  const secrets = [profileDir, path.resolve(profile), ...ENV_ALLOWLIST.map((n) => (Object.hasOwn(env, n) ? env[n] : ''))].filter((s) => s && s.length >= 3)
  // A failure's text can quote a URL; its query (a checkout session id) is cut.
  const scrub = (line) => secrets.reduce((text, s) => text.split(s).join('<redacted>'), line).replace(/(\bhttps?:\/\/[^\s?#]*)[?#]\S*/g, '$1')
  await mkdir(outDir, { recursive: true })
  const runLog = await open(path.join(outDir, 'run.log'), 'a', 0o600)
  const note = async (line) => {
    const clean = scrub(line)
    log(clean)
    await runLog.write(`${new Date().toISOString()} ${clean}\n`)
  }
  // runAction's waitUntil logs synchronously; its lines are queued in order.
  let pending = Promise.resolve()
  const noteSoon = (line) => { pending = pending.then(() => note(line)) }
  const baseOrigin = new URL(base).origin

  // Where the last scene ended, for the next one's resume. Never logged: a
  // query string can hold a checkout session id.
  let resumeUrl = null
  try {
    await note(`run: ${scenes.map((s) => s.id).join(', ')} on ${baseOrigin}`)
    for (const scene of scenes) {
      const label = `scene ${scene.id}`
      try {
        const { ms, url } = await recordScene({
          label,
          name: scene.id,
          setup: scene.setup,
          actions: scene.actions,
          outDir,
          baseUrl: base,
          size: `${PROD_VIEWPORT.width}:${PROD_VIEWPORT.height}`,
          actionOpts: {
            env,
            resumeUrl,
            log: (line) => noteSoon(`${label}: ${line}`),
            stopIf: async (page) => (new URL(page.url()).hostname === GOOGLE_HOST && (await page.locator(GOOGLE_SIGN_IN).first().isVisible().catch(() => false))
              ? 'Google asked for a sign-in: the saved session has lapsed, so sign in again with --init-profile'
              : null),
          },
          onStep: (i, action, step) => noteSoon(`${label} ${stepLine(i, action, step)}`),
          open: async (videoDir, defer) => {
            noteSoon(`${label} launch: chromium (saved profile${headed ? ', headed' : ''})`)
            const context = await launchProfile(profileDir, { headed, videoDir })
            defer(() => context.close())
            await context.addInitScript(maskValuesScript(scene.values))
            // The page made at launch is dropped, so the video starts at a
            // measured time, as in walkthrough mode.
            const blank = context.pages()
            const videoStart = Date.now()
            const page = await context.newPage()
            for (const p of blank) await p.close()
            page.on('framenavigated', (frame) => {
              if (frame === page.mainFrame()) noteSoon(`${label}: at ${where(frame.url(), baseOrigin)}`)
            })
            context.on('page', () => noteSoon(`${label}: popup opened (not filmed)`))
            return { page, videoStart }
          },
        })
        resumeUrl = url
        await pending
        await note(`scene ${scene.id} ok ${ms} ms`)
      } catch (err) {
        await pending
        const reason = scrub(firstLine(err)).replace(`${label}: `, '')
        await note(`scene ${scene.id} FAILED: ${reason}`)
        throw new RecorderError(`scene ${scene.id} FAILED: ${reason} (${path.join(outDir, 'run.log')})`)
      }
    }
  } finally {
    await pending.catch(() => {})
    await runLog.close()
  }
}
