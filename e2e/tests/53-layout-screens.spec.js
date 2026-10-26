// HZ-512: the `layout-*` screens in .horizon/screenshots.json show the layout
// each old layout-only test checked, not an empty board or a login wall. Each
// shot is loaded the way farm/capture/worker.mjs loads it — `load`, then the
// screen's own waitFor — and its anchor is then read once, with no auto-wait,
// so a waitFor that settles before the data would fail here.
//
// Plus the dark fallback the dark shots rely on: with no stored theme the UI
// follows prefers-color-scheme, and a stored choice still wins.

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/test-base.js'
import { openDb } from '../fixtures/seed.js'
import { seedLayoutScreens, PROJECT, LAST_EVENT, GATE_ID, LONG_ID, BLOCKED_ID, BLOCKER_ID } from '../fixtures/layout-screens-seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const CONFIG = JSON.parse(readFileSync(new URL('../../.horizon/screenshots.json', import.meta.url), 'utf8'))
const VIEWPORTS = Object.fromEntries(CONFIG.viewports.map((v) => [v.name, { width: v.width, height: v.height }]))

const card = (page, id) => page.locator('.card', { has: page.locator('.card__id', { hasText: new RegExp(`^${id}$`) }) })

// One anchor list per screen and viewport: every locator must be visible the
// moment the screen's waitFor is.
const ANCHORS = {
  // HZ-586: a phone shows only the Plan column, so LS-LONG (Technical Plan)
  // and LS-BLOCKED (Execute) are anchored on desktop.
  'layout-board': (page, viewport) =>
    viewport === 'phone'
      ? [
          card(page, GATE_ID).locator('.proj-badge'),
          page.getByRole('tab', { name: /^Plan, /, selected: true }),
          page.locator('.board .col .col__name', { hasText: /^Plan$/ }),
        ]
      : [
          card(page, GATE_ID).locator('.proj-badge'),
          card(page, LONG_ID).locator('.card__elapsed', { hasText: 'Summarizing reviews · <1m' }),
          card(page, BLOCKED_ID).locator('.status-pill', { hasText: 'Blocked' }),
          card(page, BLOCKED_ID).locator('.dep-pill--blocked').getByRole('link', { name: BLOCKER_ID }),
        ],
  'layout-item-activity': (page) => [page.locator('.activity-row__text', { hasText: LAST_EVENT })],
  'layout-item-badge': (page) => [page.locator('.tracker__meta .proj-badge', { hasText: PROJECT })],
  'layout-admin-tokens': (page) => [page.locator('.api-tokens__days-field').getByText('days', { exact: true })],
}

const shots = CONFIG.screens
  .filter((screen) => screen.name.startsWith('layout-'))
  .flatMap((screen) =>
    (screen.viewports || Object.keys(VIEWPORTS)).flatMap((viewport) =>
      (screen.themes || CONFIG.themes).map((theme) => ({ screen, viewport, theme })),
    ),
  )

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    seedLayoutScreens(db)
  } finally {
    db.close()
  }
})

test('every layout screen shows its seeded layout as soon as its waitFor does', async ({ page }) => {
  expect(Object.keys(ANCHORS).sort()).toEqual([...new Set(shots.map((s) => s.screen.name))].sort())
  for (const { screen, viewport, theme } of shots) {
    const label = `${screen.name} / ${viewport} / ${theme}`
    await page.setViewportSize(VIEWPORTS[viewport])
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(screen.path, { waitUntil: 'load' })
    await page.locator(screen.waitFor || CONFIG.defaults?.waitFor).first().waitFor({ state: 'visible' })
    for (const anchor of ANCHORS[screen.name](page, viewport)) {
      expect(await anchor.isVisible(), `${label}: ${anchor}`).toBe(true)
    }
    expect(await page.locator('html').getAttribute('data-theme'), label).toBe(theme === 'dark' ? 'dark' : null)
  }
})

// The capture journey itself: the config's `serve` command and the farm's own
// capture worker, sent each shot the way farm/screenshot_runner.py sends it.
// Two passes on one build must give 7 PNGs that the runner's own diff
// (farm/capture/diff.mjs, at the runner's thresholds) reads as `same`.
const REPO = fileURLToPath(new URL('../../', import.meta.url))
const WORKER = join(REPO, 'farm/capture/worker.mjs')
const DIFF = join(REPO, 'farm/capture/diff.mjs')
// The runner's thresholds: the config's `diff`, else DEFAULT_DIFF_THRESHOLD and
// DEFAULT_DIFF_RATIO_TOLERANCE in farm/screenshots_config.py.
const THRESHOLD = CONFIG.diff?.threshold ?? 0.1
const RATIO_TOLERANCE = CONFIG.diff?.ratioTolerance ?? 0.01
// The runner's waits: a shot's timeoutMs (DEFAULT_TIMEOUT_MS in
// farm/screenshots_config.py), and WORKER_LAUNCH_S for browser start-up.
const SHOT_TIMEOUT_MS = CONFIG.defaults?.timeoutMs ?? 30_000
const WORKER_LAUNCH_MS = 30_000
// farm/screenshot_runner.py's SERVE_STOP_GRACE_S and WORKER_CLOSE_S.
const SERVE_STOP_GRACE_MS = 5_000
const WORKER_CLOSE_MS = 10_000
const LOGIN_HEADER = 'X-Horizon-Test-Env-SCREENSHOT-LOGIN-KEY'

function startServe(env) {
  const proc = spawn('bash', ['-c', CONFIG.serve], { cwd: REPO, env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  proc.stderr.on('data', (chunk) => (stderr += chunk))
  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)))
  return { proc, exited, stderr: () => stderr }
}

// Ready once `ready` answers and our own key logs in through it: while serve.sh
// waits on its host-wide lock, another capture's server can hold the port.
async function waitReady(serve, key) {
  let gone = false
  serve.exited.then(() => (gone = true))
  const me = new URL('/api/auth/me', CONFIG.ready)
  for (;;) {
    if (gone) throw new Error(`serve exited before ready: ${serve.stderr()}`)
    const ok =
      (await fetch(CONFIG.ready).then((r) => r.status < 500, () => false)) &&
      (await fetch(me, { headers: { [LOGIN_HEADER]: key } }).then((r) => r.status === 200, () => false))
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

// Its own process group, as the runner starts it, so the group can be killed.
function startWorker() {
  const proc = spawn('node', [WORKER], { cwd: REPO, detached: true, stdio: ['pipe', 'pipe', 'inherit'] })
  // A worker that already died answers writes with EPIPE; next() reports it.
  proc.stdin.on('error', () => {})
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]()
  // A worker reply, or a failure naming the shot once `ms` passes without one.
  const next = async (label, ms = SHOT_TIMEOUT_MS) => {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: no worker reply in ${ms}ms`)), ms)
    })
    try {
      return JSON.parse((await Promise.race([lines.next(), timeout])).value)
    } finally {
      clearTimeout(timer)
    }
  }
  return { proc, next, send: (msg) => proc.stdin.write(`${JSON.stringify(msg)}\n`) }
}

function killGroup(proc, signal) {
  try {
    process.kill(-proc.pid, signal)
  } catch {}
}

function groupAlive(proc) {
  try {
    process.kill(-proc.pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

async function waitGroupGone(proc, ms) {
  const end = Date.now() + ms
  while (groupAlive(proc) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50))
}

// Like the runner's _stop: SIGTERM the group (serve.sh's traps clean up its
// temp dir), then SIGKILL whatever outlives the grace.
async function stopServe(serve) {
  killGroup(serve.proc, 'SIGTERM')
  await waitGroupGone(serve.proc, SERVE_STOP_GRACE_MS)
  if (groupAlive(serve.proc)) {
    killGroup(serve.proc, 'SIGKILL')
    await waitGroupGone(serve.proc, 5_000)
  }
}

// Like the runner's worker kill(): close stdin so the worker closes its
// browser, wait out the grace, then SIGKILL the group either way.
async function stopWorker(worker) {
  worker.proc.stdin.end()
  await waitGroupGone(worker.proc, WORKER_CLOSE_MS)
  killGroup(worker.proc, 'SIGKILL')
}

test("the config serve path and the farm worker capture every screen twice, matching under the runner's diff", async () => {
  test.setTimeout(180_000)
  const key = randomBytes(16).toString('hex')
  const out = mkdtempSync(join(tmpdir(), 'hz512-shots-'))
  const serve = startServe({ ...process.env, SCREENSHOT_LOGIN_KEY: key })
  let worker
  try {
    await waitReady(serve, key)
    worker = startWorker()
    expect(await worker.next('worker start', WORKER_LAUNCH_MS)).toEqual({ ready: true })
    const origin = new URL(CONFIG.ready).origin
    const passes = []
    for (const pass of [1, 2]) {
      const pngs = {}
      for (const { screen, viewport, theme } of shots) {
        const name = `${screen.name}--${viewport}--${theme}`
        const png = join(out, `${name}-${pass}.png`)
        worker.send({
          url: origin + screen.path,
          ...VIEWPORTS[viewport],
          theme,
          maxHeightPx: 10_000,
          png,
          headers: { [LOGIN_HEADER]: key },
          waitFor: screen.waitFor,
        })
        expect(await worker.next(`pass ${pass}: ${name}`, screen.timeoutMs), `pass ${pass}: ${name}`).toMatchObject({ ok: true, clipped: false })
        pngs[name] = png
      }
      passes.push(pngs)
    }
    expect(Object.keys(passes[0])).toHaveLength(7)
    const outDir = join(out, 'diff')
    const resultFile = join(out, 'diff-result.json')
    mkdirSync(outDir)
    const pairs = Object.keys(passes[0]).map((name) => ({ name, current: passes[1][name], baseline: passes[0][name] }))
    const run = spawnSync('node', [DIFF], {
      cwd: REPO,
      input: JSON.stringify({ pairs, outDir, resultFile, threshold: THRESHOLD, ratioTolerance: RATIO_TOLERANCE }),
      encoding: 'utf8',
    })
    expect(run.status, `diff.mjs failed: ${run.error ?? run.stderr}`).toBe(0)
    const { shots: diffed } = JSON.parse(readFileSync(resultFile, 'utf8'))
    expect(diffed).toHaveLength(7)
    for (const shot of diffed) {
      const why = `${shot.name} differs between passes: diffRatio ${shot.diffRatio}${shot.error ? ` (${shot.error})` : ''}`
      expect(shot.status, why).toBe('same')
    }
  } finally {
    if (worker) await stopWorker(worker)
    await stopServe(serve)
    rmSync(out, { recursive: true, force: true })
  }
})

test('with no stored theme the UI follows the browser, and a stored theme wins', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/', { waitUntil: 'load' })
  // Set before first paint by index.html's inline script, not after React mounts.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.locator('.topbar__avatar').click()
  await expect(page.getByRole('switch', { name: 'Dark mode' })).toHaveAttribute('aria-checked', 'true')

  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/', { waitUntil: 'load' })
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark')

  // A stored choice beats the browser either way.
  await page.evaluate(() => localStorage.setItem('horizon_theme', 'light'))
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/', { waitUntil: 'load' })
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark')

  await page.evaluate(() => localStorage.setItem('horizon_theme', 'dark'))
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/', { waitUntil: 'load' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})
