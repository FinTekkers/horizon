// HZ-518: the recorder's test contract. Every case spawns the real
// `node scripts/record-item.mjs` against a local stub board (stub-board.mjs);
// nothing here calls shoreward.ai or needs a real token. Chromium, ffmpeg and
// ffprobe are required: a missing one fails the suite, unless
// RECORDER_ALLOW_SKIP=1 is set, and then every skipped case is named.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { DEVICE_SCALE_FACTOR, MASK_COLOR, VIEWPORT } from '../browser.mjs'
import { BOARD_FIXTURE, SITE_FIXTURE, startStub } from './stub-board.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const ENTRY = path.join(REPO_ROOT, 'scripts/record-item.mjs')
const TOKEN = 'hzt_recorder-test-9f3c2e71b5a04d68'
const SHELL_TOKEN = 'hzt_shell-export-must-be-ignored-41aa'
const KILL_AFTER_MS = 120_000
const STEPS = ['Plan', 'Build & checks', 'Review']
// site.html's body height: a viewport-only (720 px) shot can't match it.
const SITE_HEIGHT_PX = 2000

const missing = []
if (!existsSync(chromium.executablePath())) missing.push(`Chromium (${chromium.executablePath()})`)
for (const tool of ['ffmpeg', 'ffprobe']) {
  if (spawnSync(tool, ['-version'], { stdio: 'ignore' }).status !== 0) missing.push(tool)
}
const skip = missing.length && process.env.RECORDER_ALLOW_SKIP === '1' ? `missing ${missing.join(', ')}` : false
if (missing.length && !skip) {
  test('recorder prerequisites are installed', () => {
    assert.fail(`missing ${missing.join(', ')}. Install them, or set RECORDER_ALLOW_SKIP=1 to skip the recorder metric tests`)
  })
}
const skipped = []
function contractTest(name, fn) {
  if (skip) skipped.push(name)
  test(name, { skip }, fn)
}

const work = mkdtempSync(path.join(tmpdir(), 'hz518-'))
const tokenFile = path.join(work, 'recorder.env')
writeFileSync(tokenFile, `# personal API token\nHORIZON_TOKEN=${TOKEN}\n`)

// The child sees only PATH, HOME and the recorder's own variables: no
// FARM_HOME, no HORIZON_TOKEN unless a case puts one there on purpose.
function childEnv(extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    RECORDER_POLL_MS: '100',
    RECORDER_HEARTBEAT_MS: '300',
    RECORDER_SETTLE_MS: '100',
    ...extra,
  }
}

function record(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY, ...args], { env, cwd: work, timeout: KILL_AFTER_MS, killSignal: 'SIGKILL' })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

// One full run per stub ending, shared by the cases that read its outputs.
const runs = new Map()
function runOnce(name, { end, site }) {
  if (!runs.has(name)) {
    runs.set(name, (async () => {
      const stub = await startStub({ end })
      const out = path.join(work, name)
      const args = ['HZ-1', '--board', stub.boardUrl, '--out', out]
      if (site) args.push('--site', stub.siteUrl)
      try {
        const result = await record(args, childEnv({ HORIZON_RECORDER_ENV: tokenFile }))
        return { ...result, stub, out, args, terminalLogIndex: stub.terminalLogIndex }
      } finally {
        await stub.close()
      }
    })())
  }
  return runs.get(name)
}
const closedRun = () => runOnce('closed', { end: 'closed', site: true })
const abandonedRun = () => runOnce('abandoned', { end: 'abandoned', site: false })

function timelineOf(run) {
  return JSON.parse(readFileSync(path.join(run.out, 'timeline.json'), 'utf8'))
}

function assertExitedCleanly(run) {
  assert.equal(run.signal, null, `the recorder was killed (${run.signal}); stderr: ${run.stderr}`)
  assert.equal(run.code, 0, `exit ${run.code}; stderr: ${run.stderr}`)
}

function pngSize(file) {
  const buf = readFileSync(file)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

// ---- pixel checks: boxes measured on the fixture, pixels read off the PNGs ----

let browser
before(async () => {
  if (!skip) browser = await chromium.launch()
})
after(async () => {
  await browser?.close()
  rmSync(work, { recursive: true, force: true })
  if (skipped.length) console.warn(`WARNING: recorder metric tests skipped (${skip}):\n${skipped.map((n) => `  - ${n}`).join('\n')}`)
})

// The fixture's boxes at the recorder's own viewport and scale factor. Its
// scripts are stripped, so the measuring page sends no request anywhere.
async function boxesIn(html, { fullPage = false } = {}) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR })
  try {
    const page = await context.newPage()
    await page.setContent(html.replace(/<script[\s\S]*?<\/script>/g, ''))
    return await page.evaluate((fullPage) => {
      const rect = (r) => ({ x: r.left + (fullPage ? scrollX : 0), y: r.top + (fullPage ? scrollY : 0), width: r.width, height: r.height })
      const contact = document.getElementById('contact')
      const text = contact.firstChild
      const at = text.data.search(/\S+@\S+/)
      const range = document.createRange()
      range.setStart(text, at)
      range.setEnd(text, at + text.data.slice(at).split(' ')[0].length)
      return {
        pin: rect(document.querySelector('input[type=password]').getBoundingClientRect()),
        email: rect(range.getBoundingClientRect()),
        banner: rect(document.getElementById('banner').getBoundingClientRect()),
      }
    }, fullPage)
  } finally {
    await context.close()
  }
}

// For each box: is every pixel inside it exactly MASK_COLOR? Plus the colour
// at the banner's centre, the control that the frame isn't one solid fill.
async function readPixels(file, boxes, control) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR })
  try {
    const page = await context.newPage()
    const b64 = readFileSync(file).toString('base64')
    return await page.evaluate(async ({ b64, boxes, control, mask }) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const hex = (d, i) => `#${[d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`
      const solid = boxes.map((b) => {
        const x0 = Math.ceil(b.x)
        const y0 = Math.ceil(b.y)
        const w = Math.floor(b.x + b.width) - x0
        const h = Math.floor(b.y + b.height) - y0
        const d = ctx.getImageData(x0, y0, w, h).data
        let off = 0
        for (let i = 0; i < d.length; i += 4) if (hex(d, i) !== mask) off += 1
        return { pixels: w * h, off }
      })
      const c = ctx.getImageData(Math.round(control.x + control.width / 2), Math.round(control.y + control.height / 2), 1, 1).data
      return { solid, control: hex(c, 0) }
    }, { b64, boxes, control, mask: MASK_COLOR })
  } finally {
    await context.close()
  }
}

async function assertMasked(file, boxes) {
  const { solid, control } = await readPixels(file, [boxes.pin, boxes.email], boxes.banner)
  const [pin, email] = solid
  assert.ok(pin.pixels > 0 && email.pixels > 0, `${file}: an empty box was measured`)
  assert.equal(pin.off, 0, `${file}: ${pin.off} of ${pin.pixels} PIN-box pixels are not ${MASK_COLOR}`)
  assert.equal(email.off, 0, `${file}: ${email.off} of ${email.pixels} email-box pixels are not ${MASK_COLOR}`)
  assert.notEqual(control, MASK_COLOR, `${file}: the banner outside the boxes is ${MASK_COLOR} too — the frame is one solid fill`)
}

// ---- metric line 1: three steps, a 20-minute gap, under 60 s ----

contractTest('metric 1: one timeline entry per stub step, in order, and the MP4 is under 60 s', async () => {
  const run = await closedRun()
  assertExitedCleanly(run)
  const steps = timelineOf(run).filter((e) => e.kind !== 'before' && e.kind !== 'after')
  assert.deepEqual(steps.map((e) => e.step), STEPS)
  const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(run.out, 'HZ-1.mp4')], { encoding: 'utf8' }).trim())
  assert.ok(duration > 0 && duration < 60, `ffprobe duration ${duration}`)
})

contractTest('metric 1: the 20-minute gap is exactly one caption card showing the real time, despite a ticking clock', async () => {
  const run = await closedRun()
  assertExitedCleanly(run)
  const timeline = timelineOf(run)
  const cards = timeline.filter((e) => e.kind === 'card')
  assert.equal(cards.length, 1, JSON.stringify(timeline, null, 2))
  const [card] = cards
  assert.equal(card.step, 'Build & checks')
  assert.match(card.caption, /20 min → 6 s$/)
  assert.equal(card.secondsOnScreen, 6)
  const realMin = (Date.parse(card.realEnd) - Date.parse(card.realStart)) / 60000
  assert.ok(Math.abs(realMin - 20) <= 1, `card spans ${realMin} min`)
  // The ticking clock is real: the step's board frames all differ.
  const boardFrames = readdirSync(path.join(run.out, 'frames')).filter((f) => /^\d{4}\.png$/.test(f))
  const bytes = new Set(boardFrames.map((f) => readFileSync(path.join(run.out, 'frames', f)).toString('base64')))
  assert.equal(bytes.size, boardFrames.length, 'two board frames are identical — the clock fixture is not ticking')
})

// ---- metric line 2: --site before and after cards ----

contractTest('metric 2: with --site, the first entry is before and the last is after, both full-page shots of the tall site', async () => {
  const run = await closedRun()
  assertExitedCleanly(run)
  const timeline = timelineOf(run)
  assert.equal(timeline[0].kind, 'before')
  assert.equal(timeline.at(-1).kind, 'after')
  assert.equal(timeline[0].frame, 'frames/before.png')
  assert.equal(timeline.at(-1).frame, 'frames/after.png')
  for (const name of ['before.png', 'after.png']) {
    assert.deepEqual(pngSize(path.join(run.out, 'frames', name)), { width: 1280, height: SITE_HEIGHT_PX }, name)
  }
})

contractTest('metric 2: the before shot is taken before the first poll and the after shot after the terminal poll', async () => {
  const run = await closedRun()
  assertExitedCleanly(run)
  const before = readFileSync(path.join(run.out, 'frames/before.png'))
  const after = readFileSync(path.join(run.out, 'frames/after.png'))
  assert.ok(!before.equals(after), 'before.png and after.png are the same bytes — the after shot was not retaken')
  const log = run.stub.log
  const sites = log.flatMap((r, i) => (r.path === '/site' ? [i] : []))
  const firstPoll = log.findIndex((r) => r.path === '/horizon/api/items')
  assert.equal(sites.length, 2, JSON.stringify(log))
  assert.ok(firstPoll >= 0 && run.terminalLogIndex != null)
  assert.ok(sites[0] < firstPoll, 'the before shot came after the first items poll')
  assert.ok(sites[1] > run.terminalLogIndex, 'the after shot came before the terminal poll')
})

// ---- metric line 3 and guardrail 2: masking ----

contractTest('metric 3: in every saved board frame the PIN input and the email are solid mask fill, and the banner is not', async () => {
  const run = await closedRun()
  assertExitedCleanly(run)
  const boxes = await boxesIn(BOARD_FIXTURE)
  const frames = readdirSync(path.join(run.out, 'frames')).filter((f) => /^\d{4}\.png$/.test(f))
  assert.ok(frames.length >= 3, `only ${frames.length} board frames`)
  for (const f of frames) await assertMasked(path.join(run.out, 'frames', f), boxes)
})

contractTest('guardrail 2: the --site before and after shots are masked too', async () => {
  const run = await closedRun()
  assertExitedCleanly(run)
  const boxes = await boxesIn(SITE_FIXTURE, { fullPage: true })
  assert.ok(boxes.email.y > VIEWPORT.height, 'the site email should sit below the first viewport')
  for (const name of ['before.png', 'after.png']) await assertMasked(path.join(run.out, 'frames', name), boxes)
})

// ---- metric line 4 and guardrail 2: the token ----

contractTest('metric 4: a missing HORIZON_RECORDER_ENV file exits non-zero, names the path, and ignores a shell HORIZON_TOKEN', async () => {
  const stub = await startStub()
  const absent = path.join(work, 'no-such-dir', 'recorder.env')
  try {
    const run = await record(
      ['HZ-1', '--board', stub.boardUrl, '--out', path.join(work, 'missing')],
      childEnv({ HORIZON_RECORDER_ENV: absent, HORIZON_TOKEN: SHELL_TOKEN }),
    )
    assert.equal(run.signal, null)
    assert.notEqual(run.code, 0)
    assert.ok(run.stderr.includes(absent), `stderr does not name the path: ${run.stderr}`)
    assert.ok(!`${run.stdout}${run.stderr}`.includes(SHELL_TOKEN))
    assert.deepEqual(stub.log.filter((r) => /bearer/i.test(r.authorization ?? '')), [])
  } finally {
    await stub.close()
  }
})

contractTest('metric 4: board requests carry Bearer <token>, /site requests none, and the token is nowhere in the outputs', async () => {
  const run = await closedRun()
  assertExitedCleanly(run)
  const boardReqs = run.stub.log.filter((r) => r.path.startsWith('/horizon/'))
  assert.ok(boardReqs.some((r) => r.path === '/horizon/api/items'))
  assert.ok(boardReqs.some((r) => r.path === '/horizon/api/stream'), 'the board page never opened its stream')
  for (const r of boardReqs) assert.equal(r.authorization, `Bearer ${TOKEN}`, `${r.method} ${r.path}`)
  const siteReqs = run.stub.log.filter((r) => r.path === '/site')
  assert.ok(siteReqs.length > 0)
  for (const r of siteReqs) assert.equal(r.authorization, null)

  const needle = Buffer.from(TOKEN)
  assert.ok(!run.stdout.includes(TOKEN), 'token in stdout')
  assert.ok(!run.stderr.includes(TOKEN), 'token in stderr')
  assert.ok(!readFileSync(path.join(run.out, 'timeline.json')).includes(needle), 'token in timeline.json')
  for (const f of readdirSync(path.join(run.out, 'frames'))) {
    assert.ok(!readFileSync(path.join(run.out, 'frames', f)).includes(needle), `token in frames/${f}`)
  }
})

// ---- metric line 5 and guardrail 1: closing, abandoning, read-only ----

for (const [name, getRun] of [['closes', closedRun], ['is abandoned', abandonedRun]]) {
  contractTest(`metric 5: a run whose item ${name} exits 0 and writes the MP4, frames/ and a full timeline.json`, async () => {
    const run = await getRun()
    assertExitedCleanly(run)
    assert.ok(readFileSync(path.join(run.out, 'HZ-1.mp4')).length > 0)
    assert.ok(readdirSync(path.join(run.out, 'frames')).some((f) => f.endsWith('.png')))
    const timeline = timelineOf(run)
    assert.deepEqual(timeline.filter((e) => e.kind !== 'before' && e.kind !== 'after').map((e) => e.step), STEPS)
    for (const e of timeline) {
      assert.equal(typeof e.step, 'string')
      assert.ok(!Number.isNaN(Date.parse(e.realStart)), `realStart ${e.realStart}`)
      assert.ok(!Number.isNaN(Date.parse(e.realEnd)), `realEnd ${e.realEnd}`)
      assert.ok(Date.parse(e.realStart) <= Date.parse(e.realEnd))
      assert.ok(typeof e.secondsOnScreen === 'number' && e.secondsOnScreen > 0)
    }
    assert.match(run.stdout, name === 'closes' ? /closed: HZ-1/ : /abandoned: HZ-1/)
  })
}

contractTest('metric 5 / guardrail 1: the board page tries a POST fetch and a form submit, and the stub logs only GETs', async () => {
  // Control: the fixture really does send writes when nothing blocks them.
  const control = await startStub()
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`${control.boardUrl}/HZ-1`)
    await page.waitForURL(/\/gate$/).catch(() => {})
    await context.close()
    assert.ok(control.log.some((r) => r.method === 'POST'), 'the fixture sent no POST — this case would prove nothing')
  } finally {
    await control.close()
  }
  for (const run of [await closedRun(), await abandonedRun()]) {
    assertExitedCleanly(run)
    assert.deepEqual(run.stub.log.filter((r) => r.method !== 'GET'), [])
  }
})

// ---- guardrails 3 and 4 ----

contractTest('guardrail 4: the spawned recorder gets a minimal env and only 127.0.0.1 URLs', async () => {
  const env = childEnv({ HORIZON_RECORDER_ENV: tokenFile })
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'HORIZON_RECORDER_ENV', 'PATH', 'RECORDER_HEARTBEAT_MS', 'RECORDER_POLL_MS', 'RECORDER_SETTLE_MS'])
  assert.equal(env.FARM_HOME, undefined)
  const run = await closedRun()
  const urls = run.args.filter((a) => /^https?:/.test(a))
  assert.equal(urls.length, 2)
  for (const u of urls) assert.equal(new URL(u).hostname, '127.0.0.1')
})

test('guardrail 3: this branch changes no file under server/ or ui/', (t) => {
  const git = (...args) => spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  const base = git('merge-base', 'HEAD', 'origin/main')
  if (base.status !== 0) {
    t.skip('no origin/main to diff against')
    return
  }
  const changed = git('diff', '--name-only', base.stdout.trim()).stdout.split('\n').filter(Boolean)
  const untracked = git('ls-files', '--others', '--exclude-standard').stdout.split('\n').filter(Boolean)
  assert.deepEqual([...changed, ...untracked].filter((f) => /^(server|ui)\//.test(f)), [])
})
