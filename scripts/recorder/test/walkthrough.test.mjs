// HZ-530: walkthrough mode's test contract. Every run spawns the real
// `node scripts/record-item.mjs --walkthrough` against a local stub process
// (stub-walkthrough.mjs) that the guard accepts as a hooks-on throwaway
// Horizon. Nothing here reaches a real board or another host. Chromium,
// ffmpeg and ffprobe are required, as in recorder.test.mjs.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { DEVICE_SCALE_FACTOR, VIEWPORT } from '../browser.mjs'
import { checkBoard } from '../walkthrough-guard.mjs'
import { TEMP_PREFIX, loadScenario } from '../walkthrough.mjs'
import { HOOKS_ON, startWalkthroughStub } from './stub-walkthrough.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const ENTRY = path.join(REPO_ROOT, 'scripts/record-item.mjs')
const FIXTURE = readFileSync(new URL('./fixtures/walkthrough.html', import.meta.url), 'utf8')
const KILL_AFTER_MS = 120_000
const CANARY = 'hz530-leak-canary'

const missing = []
if (!existsSync(chromium.executablePath())) missing.push(`Chromium (${chromium.executablePath()})`)
for (const tool of ['ffmpeg', 'ffprobe']) {
  if (spawnSync(tool, ['-version'], { stdio: 'ignore' }).status !== 0) missing.push(tool)
}
const skip = missing.length && process.env.RECORDER_ALLOW_SKIP === '1' ? `missing ${missing.join(', ')}` : false
if (missing.length && !skip) {
  test('walkthrough prerequisites are installed', () => {
    assert.fail(`missing ${missing.join(', ')}. Install them, or set RECORDER_ALLOW_SKIP=1 to skip the walkthrough metric tests`)
  })
}
const skipped = []
function contractTest(name, fn) {
  if (skip) skipped.push(name)
  test(name, { skip }, fn)
}

const work = mkdtempSync(path.join(tmpdir(), 'hz530-'))
const scenarios = path.join(work, 'scenarios')
// The recorder's own TMPDIR, so its temp dirs can be counted exactly.
const childTmp = path.join(work, 'tmp')
mkdirSync(scenarios)
mkdirSync(childTmp)

function scenario(name, actions) {
  writeFileSync(path.join(scenarios, `${name}.json`), JSON.stringify({ actions }))
  return name
}

function childEnv(extra = {}) {
  return { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: childTmp, RECORDER_WALKTHROUGH_DIR: scenarios, ...extra }
}

function record(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY, ...args], { env: childEnv(env), cwd: work, timeout: KILL_AFTER_MS, killSignal: 'SIGKILL' })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

async function walkthrough(name, { board, out = path.join(work, 'out', name), env } = {}) {
  const run = await record(['--walkthrough', name, '--board', board, '--out', out], env)
  return { ...run, out, mp4: path.join(out, `${name}.mp4`) }
}

function assertExitedCleanly(run) {
  assert.equal(run.signal, null, `the recorder was killed (${run.signal}); stderr: ${run.stderr}`)
  assert.equal(run.code, 0, `exit ${run.code}; stderr: ${run.stderr}`)
}

function duration(mp4) {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4], { encoding: 'utf8' }).trim())
}

// One decoded frame at `sec`, as raw RGB at the recorder's 1280×720.
function frameAt(mp4, sec) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', sec.toFixed(3), '-i', mp4, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 16 * 1024 * 1024 })
  assert.equal(raw.length, VIEWPORT.width * VIEWPORT.height * 3, `no frame at ${sec}s`)
  return raw
}

// How many pixels inside the box (inset by 2 px for the encoder's soft
// edges) are more than `tol` off `rgb` on any channel.
function offPixels(frame, box, rgb, tol) {
  const x0 = Math.ceil(box.x) + 2
  const y0 = Math.ceil(box.y) + 2
  const x1 = Math.floor(box.x + box.width) - 2
  const y1 = Math.floor(box.y + box.height) - 2
  assert.ok(x1 > x0 && y1 > y0, `empty box ${JSON.stringify(box)}`)
  let off = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * VIEWPORT.width + x) * 3
      if (rgb.some((v, c) => Math.abs(frame[i + c] - v) > tol)) off += 1
    }
  }
  return { off, pixels: (x1 - x0) * (y1 - y0) }
}

const BLACK = [0, 0, 0]
const CARD = [0x0b, 0x10, 0x20]

let browser
before(async () => {
  if (!skip) browser = await chromium.launch()
})
after(async () => {
  await browser?.close()
  rmSync(work, { recursive: true, force: true })
  if (skipped.length) console.warn(`WARNING: walkthrough metric tests skipped (${skip}):\n${skipped.map((n) => `  - ${n}`).join('\n')}`)
})

// The fixture's boxes at the recorder's viewport, measured once its
// late-arriving email is in. The fixture's script makes no request.
async function fixtureBoxes() {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR })
  try {
    const page = await context.newPage()
    await page.setContent(FIXTURE)
    await page.waitForFunction(() => document.getElementById('late').textContent.length > 0)
    return await page.evaluate(() => {
      const rect = (r) => ({ x: r.left, y: r.top, width: r.width, height: r.height })
      const email = (id) => {
        const text = document.getElementById(id).firstChild
        const at = text.data.search(/\S+@\S+/)
        const range = document.createRange()
        range.setStart(text, at)
        range.setEnd(text, at + text.data.slice(at).split(' ')[0].length)
        return rect(range.getBoundingClientRect())
      }
      return {
        pin: rect(document.querySelector('input[type=password]').getBoundingClientRect()),
        email: email('contact'),
        late: email('late'),
        banner: rect(document.getElementById('banner').getBoundingClientRect()),
      }
    })
  } finally {
    await context.close()
  }
}

// ---- metric line 1: duration and caption card ----

contractTest('metric 1: a caption + type + pause scenario encodes to an MP4 within 1 s of 6000 ms, with the caption card at 1.0 s', async () => {
  const stub = await startWalkthroughStub()
  try {
    const name = scenario('stub-timing', [
      { action: 'caption', text: 'Set up the farm for your project', ms: 2000 },
      { action: 'type', selector: '#note', text: 'twenty characters!!!', delayMs: 100 },
      { action: 'pause', ms: 2000 },
    ])
    const run = await walkthrough(name, { board: stub.url })
    assertExitedCleanly(run)
    const seconds = duration(run.mp4)
    assert.ok(Math.abs(seconds * 1000 - 6000) <= 1000, `ffprobe duration ${seconds}s, expected 6 s ± 1 s`)
    const frame = frameAt(run.mp4, 1.0)
    const corner = offPixels(frame, { x: 20, y: 80, width: 300, height: 200 }, CARD, 16)
    assert.equal(corner.off, 0, `${corner.off} of ${corner.pixels} pixels at 1.0 s are not the caption card's #0b1020`)
    // Control: after the caption the page itself shows (its blue banner).
    const later = frameAt(run.mp4, 4.5)
    assert.ok(offPixels(later, { x: 20, y: 80, width: 300, height: 200 }, CARD, 16).off > 0, 'the caption card never went away')
  } finally {
    await stub.close()
  }
})

// ---- metric line 2: a failing step ----

const recorderTemps = () => readdirSync(childTmp).filter((f) => f.startsWith(TEMP_PREFIX))
const webms = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.webm')) : [])

contractTest('metric 2: a waitFor that never matches exits non-zero, names the scenario, step index and action, and leaves <out> as it was', async () => {
  const stub = await startWalkthroughStub()
  try {
    const name = scenario('stub-fail', [{ action: 'pause', ms: 300 }, { action: 'waitFor', selector: '#never', timeoutMs: 1000 }])
    const out = path.join(work, 'out', 'kept')
    mkdirSync(out, { recursive: true })
    writeFileSync(path.join(out, 'keep.txt'), 'already here\n')
    const run = await walkthrough(name, { board: stub.url, out })
    assert.equal(run.signal, null)
    assert.notEqual(run.code, 0)
    assert.match(run.stderr, /walkthrough stub-fail: step 1 \(waitFor\) failed/)
    assert.deepEqual(readdirSync(out), ['keep.txt'])
    assert.equal(readFileSync(path.join(out, 'keep.txt'), 'utf8'), 'already here\n')
    assert.deepEqual(recorderTemps(), [], 'the recorder temp dir (and its .webm) was left behind')
    assert.deepEqual(webms(childTmp), [])
  } finally {
    await stub.close()
  }
})

contractTest('metric 2: a failure at step 0 has the same stderr format and creates no <out>', async () => {
  const stub = await startWalkthroughStub()
  try {
    const name = scenario('stub-fail-first', [{ action: 'waitFor', selector: '#never', timeoutMs: 1000 }])
    const run = await walkthrough(name, { board: stub.url })
    assert.notEqual(run.code, 0)
    assert.match(run.stderr, /walkthrough stub-fail-first: step 0 \(waitFor\) failed/)
    assert.equal(existsSync(run.out), false, `${run.out} was created`)
    assert.deepEqual(recorderTemps(), [])
    assert.deepEqual(webms(childTmp), [])
  } finally {
    await stub.close()
  }
})

// ---- metric line 3: refused boards ----

function assertRefused(run, stub, what) {
  assert.equal(run.signal, null, what)
  assert.equal(run.code, 1, `${what}: exit ${run.code}; stderr: ${run.stderr}`)
  assert.match(run.stderr, /walkthrough refused --board/, what)
  assert.doesNotMatch(run.stdout, /launch/, `${what}: a browser was launched`)
  if (stub) assert.deepEqual(stub.log, [], `${what}: the board got a request`)
}

contractTest('metric 3: non-loopback and look-alike hosts are refused before any request, even when the board is reachable', async () => {
  // Listens on every address, so 127.0.0.2 really reaches it.
  const stub = await startWalkthroughStub({ host: '0.0.0.0' })
  const name = scenario('stub-short', [{ action: 'pause', ms: 200 }])
  try {
    for (const board of [
      `http://127.0.0.2:${stub.port}`,
      `http://localhost.example.com:${stub.port}`,
      `http://localhost@127.0.0.2:${stub.port}`,
      `https://127.0.0.1.nip.io:${stub.port}`,
      // Pinned: only the lowercase spelling passes.
      `http://LOCALHOST:${stub.port}`,
    ]) {
      const run = await walkthrough(name, { board })
      await stub.settle()
      assertRefused(run, stub, board)
    }
    // Control: the same stub on 127.0.0.1 is accepted and does get requests,
    // so the empty logs above mean something.
    const ok = await walkthrough(name, { board: stub.url })
    assertExitedCleanly(ok)
    await stub.settle()
    assert.ok(stub.log.length > 0)
  } finally {
    await stub.close()
  }
})

contractTest('metric 3: loopback boards without HORIZON_TEST_HOOKS=1, and port 3001, are refused before any request', async () => {
  const name = scenario('stub-short', [{ action: 'pause', ms: 200 }])
  for (const [what, env] of [
    ['no HORIZON_TEST_HOOKS', (port) => ({ VITE_PROXY_TARGET: `http://127.0.0.1:${port}` })],
    ['HORIZON_TEST_HOOKS=0', (port) => ({ HORIZON_TEST_HOOKS: '0', VITE_PROXY_TARGET: `http://127.0.0.1:${port}` })],
  ]) {
    const stub = await startWalkthroughStub({ env })
    try {
      const run = await walkthrough(name, { board: stub.url })
      await stub.settle()
      assertRefused(run, stub, what)
      assert.match(run.stderr, /HORIZON_TEST_HOOKS=1/, what)
    } finally {
      await stub.close()
    }
  }
  // Nothing is started on 3001 here: the guard must refuse it without
  // looking, whatever listens there.
  const live = await walkthrough(name, { board: 'http://127.0.0.1:3001' })
  assertRefused(live, null, 'port 3001')
  assert.match(live.stderr, /port 3001/)
})

// A /proc look-alike with one hooks-on listener on `port`, holding `environ`.
function fakeProc(port, environ) {
  const root = mkdtempSync(path.join(work, 'proc-'))
  mkdirSync(path.join(root, 'net'))
  const hex = port.toString(16).toUpperCase().padStart(4, '0')
  writeFileSync(path.join(root, 'net', 'tcp'), [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    `   0: 0100007F:${hex} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 424242 1 0000000000000000 100 0 0 10 0`,
    '',
  ].join('\n'))
  mkdirSync(path.join(root, '4242', 'fd'), { recursive: true })
  symlinkSync('socket:[424242]', path.join(root, '4242', 'fd', '3'))
  writeFileSync(path.join(root, '4242', 'environ'), `${Object.entries(environ).map(([k, v]) => `${k}=${v}`).join('\0')}\0`)
  return root
}

contractTest('metric 3: port 3001 is refused before /proc is read, even when a hooks-on listener is there', async () => {
  const at3001 = fakeProc(3001, { HORIZON_TEST_HOOKS: '1', VITE_PROXY_TARGET: 'http://127.0.0.1:3001' })
  await assert.rejects(checkBoard('http://127.0.0.1:3001', { procRoot: at3001 }), /port 3001, the live horizon-server/)
  // Control: the same fake /proc on another port passes, so the refusal
  // above is the port rule, not a broken fake.
  const at5490 = fakeProc(5490, { HORIZON_TEST_HOOKS: '1', VITE_PROXY_TARGET: 'http://127.0.0.1:5490' })
  assert.deepEqual(await checkBoard('http://127.0.0.1:5490', { procRoot: at5490 }), { uiPort: 5490, apiPort: 5490 })
})

// ---- metric line 4: masks ----

contractTest('metric 4: the PIN input and the email are solid mask fill in frame 0 and across the video, and a late email is masked too', async () => {
  const stub = await startWalkthroughStub()
  try {
    const name = scenario('stub-masks', [
      { action: 'pause', ms: 1000 },
      { action: 'type', selector: '#note', text: 'notes', delayMs: 100 },
      { action: 'pause', ms: 1500 },
    ])
    const run = await walkthrough(name, { board: stub.url })
    assertExitedCleanly(run)
    const boxes = await fixtureBoxes()
    const end = duration(run.mp4)
    const times = [0, end * 0.3, end * 0.6, end - 0.15]
    for (const t of times) {
      const frame = frameAt(run.mp4, t)
      for (const key of ['pin', 'email']) {
        const { off, pixels } = offPixels(frame, boxes[key], BLACK, 24)
        assert.equal(off, 0, `${key} at ${t.toFixed(2)}s: ${off} of ${pixels} pixels are not mask fill`)
      }
      assert.ok(offPixels(frame, boxes.banner, BLACK, 24).off > 0, `the banner at ${t.toFixed(2)}s is mask fill too — the frame is one solid fill`)
    }
    // The late email was added 500 ms after load; by mid-video it is on screen.
    for (const t of times.slice(2)) {
      const { off, pixels } = offPixels(frameAt(run.mp4, t), boxes.late, BLACK, 24)
      assert.equal(off, 0, `late email at ${t.toFixed(2)}s: ${off} of ${pixels} pixels are not mask fill`)
    }
  } finally {
    await stub.close()
  }
})

// ---- guardrails ----

contractTest('guardrail 1: the browser aborts a fetch and an image to another host, and the log names only the host', async () => {
  const stub = await startWalkthroughStub()
  try {
    const name = scenario('stub-egress', [{ action: 'goto', path: '/egress' }, { action: 'pause', ms: 800 }])
    const run = await walkthrough(name, { board: stub.url })
    assertExitedCleanly(run)
    assert.match(run.stdout, /^blocked fetch to example\.org$/m)
    assert.match(run.stdout, /^blocked image to example\.org$/m)
    const blocked = run.stdout.split('\n').filter((l) => l.startsWith('blocked'))
    assert.deepEqual(blocked.filter((l) => !/^blocked \w+ to example\.org$/.test(l)), [], 'a blocked line names more than the host')
    assert.ok(!`${run.stdout}${run.stderr}`.includes('canary'), 'the log holds the URL query')
    await stub.settle()
    assert.deepEqual(stub.log.map((r) => r.path), ['/', '/egress'])
  } finally {
    await stub.close()
  }
})

contractTest('guardrail 2: a hooks-on listener whose VITE_PROXY_TARGET is missing or on port 3001 is refused before any request', async () => {
  const name = scenario('stub-short', [{ action: 'pause', ms: 200 }])
  for (const [what, env] of [
    ['VITE_PROXY_TARGET missing', () => ({ HORIZON_TEST_HOOKS: '1' })],
    ['VITE_PROXY_TARGET on 3001', () => ({ HORIZON_TEST_HOOKS: '1', VITE_PROXY_TARGET: 'http://127.0.0.1:3001' })],
  ]) {
    const stub = await startWalkthroughStub({ env })
    try {
      const run = await walkthrough(name, { board: stub.url })
      await stub.settle()
      assertRefused(run, stub, what)
      assert.match(run.stderr, /VITE_PROXY_TARGET/, what)
    } finally {
      await stub.close()
    }
  }
})

contractTest('guardrail 4: the board process environment never reaches stdout, stderr or the error', async () => {
  const stub = await startWalkthroughStub({ env: (port) => ({ HORIZON_TEST_HOOKS: '0', SECRET_PROBE: CANARY, VITE_PROXY_TARGET: `http://127.0.0.1:${port}` }) })
  try {
    const run = await walkthrough(scenario('stub-short', [{ action: 'pause', ms: 200 }]), { board: stub.url })
    await stub.settle()
    assertRefused(run, stub, 'canary')
    assert.ok(!`${run.stdout}${run.stderr}`.includes(CANARY), 'the canary leaked into the output')
    const err = await checkBoard(stub.url).then(() => null, (e) => e)
    assert.ok(err, 'checkBoard accepted a HORIZON_TEST_HOOKS=0 board')
    assert.ok(!`${err.message}${err.stack}`.includes(CANARY), 'the canary leaked into the error')
  } finally {
    await stub.close()
  }
})

test('guardrail 4: a scenario file holding an email address is rejected without echoing it', async () => {
  writeFileSync(path.join(scenarios, 'has-email.json'), JSON.stringify({ actions: [{ action: 'type', selector: '#note', text: 'a@b.co', delayMs: 0 }] }))
  await assert.rejects(loadScenario('has-email', scenarios), (err) => {
    assert.match(err.message, /walkthrough has-email: .*step 0 \(type\): holds an email address/)
    assert.ok(!err.message.includes('a@b.co'))
    return true
  })
  // Control: the same scenario without the address loads.
  writeFileSync(path.join(scenarios, 'no-email.json'), JSON.stringify({ actions: [{ action: 'type', selector: '#note', text: 'a at b', delayMs: 0 }] }))
  assert.equal((await loadScenario('no-email', scenarios)).actions.length, 1)
})

// ---- HZ-665: the throwaway board's login ----

const LOGIN_KEY = 'hz665-login-key-canary'
const loginStub = (root) => startWalkthroughStub({ env: (port) => ({ ...HOOKS_ON(port), STUB_EXPECT_KEY: LOGIN_KEY, ...(root && { STUB_ROOT: root }) }) })

contractTest('HZ-665: with SCREENSHOT_LOGIN_KEY set every board request carries it, without it none does, and it is never printed', async () => {
  const name = scenario('stub-login-ok', [{ action: 'waitFor', selector: '.app' }, { action: 'pause', ms: 300 }])
  const stub = await loginStub('login')
  try {
    const run = await walkthrough(name, { board: stub.url, env: { SCREENSHOT_LOGIN_KEY: LOGIN_KEY } })
    assertExitedCleanly(run)
    await stub.settle()
    assert.deepEqual(stub.log.map((r) => r.path), ['/', '/api/auth/me'])
    assert.ok(stub.log.every((r) => r.key === true), `a request went without the key: ${JSON.stringify(stub.log)}`)
    assert.ok(!`${run.stdout}${run.stderr}`.includes(LOGIN_KEY), 'the key leaked into the output')
  } finally {
    await stub.close()
  }
  // Control: the same run without the key sends no header at all.
  const bare = await loginStub()
  try {
    const run = await walkthrough(scenario('stub-short', [{ action: 'pause', ms: 200 }]), { board: bare.url })
    assertExitedCleanly(run)
    await bare.settle()
    assert.ok(bare.log.length > 0)
    assert.ok(bare.log.every((r) => r.key === false), `a request carried a key: ${JSON.stringify(bare.log)}`)
  } finally {
    await bare.close()
  }
})

contractTest('HZ-665: a board that draws Sign in after load fails the run with "showed the login screen", writes no MP4 and never prints the key', async () => {
  const stub = await loginStub('login')
  try {
    const name = scenario('stub-login-wrong', [{ action: 'pause', ms: 200 }])
    const run = await walkthrough(name, { board: stub.url, env: { SCREENSHOT_LOGIN_KEY: 'not-the-key' } })
    assert.equal(run.signal, null)
    assert.notEqual(run.code, 0)
    assert.match(run.stderr, /walkthrough stub-login-wrong: the board showed the login screen/)
    assert.equal(existsSync(run.mp4), false, `${run.mp4} was written`)
    assert.equal(existsSync(run.out), false, `${run.out} was created`)
    assert.ok(!`${run.stdout}${run.stderr}`.includes('not-the-key'), 'the key leaked into the output')
    assert.deepEqual(recorderTemps(), [])
  } finally {
    await stub.close()
  }
})
