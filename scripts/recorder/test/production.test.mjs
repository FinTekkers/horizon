// HZ-698: production mode's test contract. Every run spawns the real
// `node scripts/record-item.mjs --production` against the local stub process
// (stub-walkthrough.mjs) with a temp --profile. Nothing here contacts
// shoreward.ai, Google or Stripe. Chromium, ffmpeg and ffprobe are required,
// as in walkthrough.test.mjs.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { PROD_VIEWPORT } from '../browser.mjs'
import { PROFILE_MARKER, checkProfile, initProfile } from '../profile.mjs'
import { TEMP_PREFIX } from '../walkthrough.mjs'
import { HOOKS_ON, startWalkthroughStub } from './stub-walkthrough.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const ENTRY = path.join(REPO_ROOT, 'scripts/record-item.mjs')
const KILL_AFTER_MS = 120_000
const PROMO = 'HZ698PROMOCANARY'
const LOGIN_KEY = 'hz698-login-key-canary'

const missing = []
if (!existsSync(chromium.executablePath())) missing.push(`Chromium (${chromium.executablePath()})`)
for (const tool of ['ffmpeg', 'ffprobe']) {
  if (spawnSync(tool, ['-version'], { stdio: 'ignore' }).status !== 0) missing.push(tool)
}
const skip = missing.length && process.env.RECORDER_ALLOW_SKIP === '1' ? `missing ${missing.join(', ')}` : false
if (missing.length && !skip) {
  test('production prerequisites are installed', () => {
    assert.fail(`missing ${missing.join(', ')}. Install them, or set RECORDER_ALLOW_SKIP=1 to skip the production metric tests`)
  })
}
const skipped = []
function contractTest(name, fn) {
  if (skip) skipped.push(name)
  test(name, { skip }, fn)
}

const work = mkdtempSync(path.join(tmpdir(), 'hz698-'))
const scenes = path.join(work, 'scenes')
const childTmp = path.join(work, 'tmp')
mkdirSync(scenes)
mkdirSync(childTmp)
const stubs = []

after(async () => {
  for (const stub of stubs) await stub.close()
  rmSync(work, { recursive: true, force: true })
  if (skipped.length) console.warn(`WARNING: production metric tests skipped (${skip}):\n${skipped.map((n) => `  - ${n}`).join('\n')}`)
})

function scene(id, actions) {
  writeFileSync(path.join(scenes, `${id}.json`), JSON.stringify({ actions }))
  return id
}

// A recorder profile as --init-profile leaves it: mode 0700 with the marker.
function profileDir(parent = work, { marker = true, mode = 0o700 } = {}) {
  const dir = mkdtempSync(path.join(parent, 'profile-'))
  if (marker) writeFileSync(path.join(dir, PROFILE_MARKER), 'test\n')
  chmodSync(dir, mode)
  return dir
}

function record(args, env = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(process.execPath, [ENTRY, ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: childTmp, RECORDER_SCENE_DIR: scenes, ...env },
      cwd: work,
      timeout: KILL_AFTER_MS,
      killSignal: 'SIGKILL',
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr, wallMs: Date.now() - startedAt }))
  })
}

let outNo = 0
async function production(selector, { base, profile, env, out = path.join(work, 'out', String(++outNo)) } = {}) {
  const run = await record(['--production', base, '--profile', profile, ...selector, '--out', out], env)
  const logFile = path.join(out, 'run.log')
  return { ...run, out, log: existsSync(logFile) ? readFileSync(logFile, 'utf8') : '' }
}

async function stub(env = HOOKS_ON) {
  const s = await startWalkthroughStub({ env })
  stubs.push(s)
  return s
}

function assertExitedCleanly(run) {
  assert.equal(run.signal, null, `the recorder was killed (${run.signal}); stderr: ${run.stderr}`)
  assert.equal(run.code, 0, `exit ${run.code}; stderr: ${run.stderr}\nrun.log:\n${run.log}`)
}

function probe(mp4) {
  const size = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', mp4], { encoding: 'utf8' }).trim()
  const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4], { encoding: 'utf8' }).trim())
  return { size, seconds }
}

// The run log's lines as { at (ms), text }.
function logLines(log) {
  return log.trim().split('\n').map((line) => {
    const at = line.indexOf(' ')
    return { at: Date.parse(line.slice(0, at)), text: line.slice(at + 1) }
  })
}
const lineAt = (log, re) => logLines(log).find((l) => re.test(l.text))

const recorderTemps = () => readdirSync(childTmp).filter((f) => f.startsWith(TEMP_PREFIX))

// ---- metric line 1: one MP4 per scene, 1920×1080, real time, a saved profile ----

let chapterRun
function chapter() {
  chapterRun ??= (async () => {
    const s = await stub()
    scene('P1', [
      { action: 'caption', text: 'Chapter P', ms: 1500 },
      { action: 'goto', path: '/production/set-session' },
      { action: 'waitFor', selector: '#set' },
      { action: 'pause', ms: 5000 },
    ])
    // A new browser launch that only sees #signed-in if P1's cookie was saved.
    scene('P2', [
      { action: 'goto', path: '/production/session' },
      { action: 'waitUntil', selector: '#signed-in', timeoutMs: 5000 },
      { action: 'pause', ms: 1000 },
    ])
    const profile = profileDir()
    return { stub: s, profile, run: await production(['--chapter', 'P'], { base: s.url, profile }) }
  })()
  return chapterRun
}

contractTest('metric 1: --chapter over a 2-scene dir writes exactly P1.mp4, P2.mp4 and run.log, each MP4 1920x1080', async () => {
  const { run } = await chapter()
  assertExitedCleanly(run)
  assert.deepEqual(readdirSync(run.out).sort(), ['P1.mp4', 'P2.mp4', 'run.log'])
  for (const id of ['P1', 'P2']) assert.equal(probe(path.join(run.out, `${id}.mp4`)).size, `${PROD_VIEWPORT.width}x${PROD_VIEWPORT.height}`, id)
  assert.deepEqual(recorderTemps(), [], 'a recorder temp dir (and its .webm) was left behind')
})

contractTest('metric 1: each MP4\'s duration is within 10% of its scene\'s measured run time, which is real time', async () => {
  const { run } = await chapter()
  assertExitedCleanly(run)
  for (const id of ['P1', 'P2']) {
    const m = new RegExp(`scene ${id} ok (\\d+) ms`).exec(run.log)
    assert.ok(m, `no "scene ${id} ok" line in run.log:\n${run.log}`)
    const ms = Number(m[1])
    const { seconds } = probe(path.join(run.out, `${id}.mp4`))
    assert.ok(Math.abs(seconds * 1000 - ms) <= ms * 0.1, `${id}: ffprobe ${seconds} s vs ${ms} ms`)
    assert.ok(ms <= run.wallMs, `${id}: ${ms} ms is longer than the whole run (${run.wallMs} ms)`)
  }
  // P1's caption and pause alone are 6.5 s: the span is measured, not made up.
  const p1 = Number(/scene P1 ok (\d+) ms/.exec(run.log)[1])
  assert.ok(p1 >= 6500, `P1 ran ${p1} ms, under its 6500 ms of fixed times`)
})

contractTest('metric 1: --profile persists: scene 2, a new launch, sees scene 1\'s session; a fresh profile does not', async () => {
  const { run, stub: s } = await chapter()
  assertExitedCleanly(run)
  assert.match(run.log, /scene P2: found #signed-in/)
  // Control: P2 alone with an empty profile times out.
  const fresh = await production(['--scene', 'P2'], { base: s.url, profile: profileDir() })
  assert.equal(fresh.code, 1, fresh.stderr)
  assert.match(fresh.log, /scene P2 FAILED: step 1 \(waitUntil\) failed: timeout after 5 s waiting for #signed-in/)
})

// ---- metric line 2: waitUntil ----

contractTest('metric 2: waitUntil keeps recording until #late appears: the wait starts before the reveal and ends after it', async () => {
  const s = await stub()
  scene('W1', [
    { action: 'goto', path: '/production' },
    { action: 'waitUntil', selector: '#late', timeoutMs: 20000 },
    { action: 'pause', ms: 1500 },
  ])
  const run = await production(['--scene', 'W1'], { base: s.url, profile: profileDir() })
  assertExitedCleanly(run)
  await s.settle()
  const revealed = s.log.find((r) => r.path === '/production/beacon/revealed')
  assert.ok(revealed, 'the page never revealed #late')
  const start = lineAt(run.log, /^scene W1: waiting for #late/)
  const end = lineAt(run.log, /^scene W1: found #late/)
  assert.ok(start && end, `no wait lines in run.log:\n${run.log}`)
  assert.ok(start.at < revealed.at, 'the wait started after the reveal')
  assert.ok(end.at >= revealed.at, 'the wait ended before the reveal')
  const { seconds } = probe(path.join(run.out, 'W1.mp4'))
  assert.ok(seconds >= 5.5 - 0.05, `W1.mp4 is ${seconds} s, under the 4 s reveal plus the 1.5 s pause`)
})

contractTest('metric 2: a waitUntil that never matches exits 1 with a timeout line in run.log and leaves no .mp4 or .part', async () => {
  const s = await stub()
  scene('T1', [{ action: 'goto', path: '/production' }, { action: 'waitUntil', selector: '#never', timeoutMs: 3000 }])
  const run = await production(['--scene', 'T1'], { base: s.url, profile: profileDir() })
  assert.equal(run.signal, null)
  assert.equal(run.code, 1, run.stderr)
  assert.match(run.log, /scene T1 FAILED: step 1 \(waitUntil\) failed: timeout after 3 s waiting for #never/)
  assert.match(run.stderr, /scene T1 FAILED/)
  assert.deepEqual(readdirSync(run.out), ['run.log'])
  assert.deepEqual(recorderTemps(), [])
})

// ---- metric line 4: the promotion code comes from the environment ----

contractTest('metric 4: --scene A3 with SHOREWARD_PROMO_CODE unset or empty exits 1 before any browser or request, and makes no --out', async () => {
  const s = await stub()
  for (const env of [{}, { SHOREWARD_PROMO_CODE: '' }]) {
    // The real scene dir: RECORDER_SCENE_DIR is cleared.
    const run = await production(['--scene', 'A3'], { base: s.url, profile: profileDir(), env: { ...env, SHOREWARD_TENANT_EMAIL: 'a@b.test', RECORDER_SCENE_DIR: '' } })
    await s.settle()
    assert.equal(run.signal, null)
    assert.equal(run.code, 1, run.stderr)
    assert.match(run.stderr, /A3: SHOREWARD_PROMO_CODE is unset/)
    assert.equal(existsSync(run.out), false, `${run.out} was created`)
    assert.doesNotMatch(run.stdout, /launch/)
    assert.deepEqual(s.log, [], 'the stub got a request')
    assert.deepEqual(recorderTemps(), [])
  }
})

// ---- guardrails ----

test('guardrail 1: --init-profile makes a 0700 dir with the marker and opens Chromium with no automation flag; the dir then passes checkProfile', async () => {
  const argvFile = path.join(work, 'init-argv')
  const fake = path.join(work, 'fake-chromium')
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\n`, { mode: 0o755 })
  const dir = path.join(work, 'home', 'parvati.profile')
  const lines = []
  await initProfile(dir, { baseUrl: 'http://127.0.0.1:5490', log: (l) => lines.push(l), executablePath: fake })
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.ok(statSync(path.join(dir, PROFILE_MARKER)).isFile())
  const argv = readFileSync(argvFile, 'utf8').trim().split('\n')
  assert.ok(argv.includes(`--user-data-dir=${realpathSync(dir)}`), argv.join(' '))
  assert.ok(argv.includes('--password-store=basic'), argv.join(' '))
  assert.ok(argv.includes('--no-first-run'), argv.join(' '))
  assert.ok(argv.includes('--no-sandbox'), argv.join(' '))
  assert.ok(!argv.some((a) => a.includes('enable-automation')), argv.join(' '))
  assert.equal(argv.at(-1), 'http://127.0.0.1:5490/horizon/')
  assert.ok(!lines.join('\n').includes(dir), 'the log names the profile path')
  assert.equal(await checkProfile(dir), realpathSync(dir))
  // A non-empty dir it didn't make (a browser profile, say) is refused.
  const other = mkdtempSync(path.join(work, 'other-'))
  writeFileSync(path.join(other, 'Cookies'), '')
  await assert.rejects(initProfile(other, { baseUrl: 'http://127.0.0.1:5490', log: () => {}, executablePath: fake }), /new or empty directory/)
})

test('guardrail 1: the README\'s "Making it" section explains the --no-sandbox notice', () => {
  const readme = readFileSync(path.join(REPO_ROOT, 'scripts/recorder/README.md'), 'utf8')
  const start = readme.indexOf('### Making it\n')
  assert.ok(start >= 0, 'no "### Making it" section')
  const rest = readme.slice(start + '### Making it\n'.length)
  const end = rest.search(/^#{1,3} /m)
  const section = end < 0 ? rest : rest.slice(0, end)
  for (const words of ['unsupported command-line flag', '--no-sandbox', 'AppArmor']) {
    assert.ok(section.includes(words), `"Making it" doesn't mention ${words}`)
  }
})

contractTest('guardrail 3: a --profile in the repo, without the marker, under ~/.config/google-chrome or with mode 0755 is refused before any browser, without naming the path', async () => {
  const s = await stub()
  scene('R1', [{ action: 'pause', ms: 200 }])
  const fakeHome = path.join(work, 'fake-home')
  mkdirSync(path.join(fakeHome, '.config', 'google-chrome'), { recursive: true })
  const inRepo = profileDir(REPO_ROOT)
  try {
    for (const [what, profile, env] of [
      ['in the repo', inRepo],
      ['no marker', profileDir(work, { marker: false })],
      ['google-chrome', profileDir(path.join(fakeHome, '.config', 'google-chrome')), { HOME: fakeHome }],
      ['mode 0755', profileDir(work, { mode: 0o755 })],
    ]) {
      const run = await production(['--scene', 'R1'], { base: s.url, profile, env })
      await s.settle()
      assert.equal(run.code, 1, `${what}: ${run.stderr}`)
      assert.match(run.stderr, /production refused --profile/, what)
      assert.doesNotMatch(run.stdout, /launch/, `${what}: a browser was launched`)
      assert.deepEqual(s.log, [], `${what}: the stub got a request`)
      assert.ok(!`${run.stdout}${run.stderr}`.includes(path.basename(profile)), `${what}: the error names the path`)
      assert.equal(existsSync(run.out), false, `${what}: --out was made`)
    }
  } finally {
    rmSync(inRepo, { recursive: true, force: true })
  }
  // Control: a good profile records.
  const ok = await production(['--scene', 'R1'], { base: s.url, profile: profileDir() })
  assertExitedCleanly(ok)
})

// One run typing the promo canary into the stub's #promo, with a login-key
// canary in the environment and a stub that would accept it.
let typedRun
function typed() {
  typedRun ??= (async () => {
    const s = await stub((port) => ({ ...HOOKS_ON(port), STUB_EXPECT_KEY: LOGIN_KEY }))
    scene('M1', [
      { action: 'goto', path: '/production' },
      { action: 'pause', ms: 1000 },
      { action: 'typeEnv', selector: '#promo', env: 'SHOREWARD_PROMO_CODE', delayMs: 200 },
      { action: 'pause', ms: 1000 },
    ])
    const profile = profileDir()
    const run = await production(['--scene', 'M1'], { base: s.url, profile, env: { SHOREWARD_PROMO_CODE: PROMO, SCREENSHOT_LOGIN_KEY: LOGIN_KEY } })
    await s.settle()
    return { stub: s, profile, run }
  })()
  return typedRun
}

contractTest('guardrail 2: no request carries the login header, and the promo code, login key and profile path are in no log or output', async () => {
  const { stub: s, profile, run } = await typed()
  assertExitedCleanly(run)
  assert.ok(s.log.length > 0)
  assert.ok(s.log.every((r) => r.key === false), `a request carried the login key: ${JSON.stringify(s.log)}`)
  const all = `${run.log}${run.stdout}${run.stderr}`
  for (const [what, secret] of [['promo code', PROMO], ['login key', LOGIN_KEY], ['profile path', profile], ['profile name', path.basename(profile)]]) {
    assert.ok(!all.includes(secret), `the ${what} leaked into the log or output`)
  }
  assert.match(run.log, /scene M1 step 2 typeEnv #promo from SHOREWARD_PROMO_CODE/)
})

contractTest('guardrail 2: the mask covers #promo before the first keypress, and frames taken mid-typing are black over it', async () => {
  const { stub: s, run } = await typed()
  assertExitedCleanly(run)
  const keys = s.log.filter((r) => r.path.startsWith('/production/beacon/first-key-')).map((r) => r.path)
  assert.deepEqual(keys, ['/production/beacon/first-key-covered'])
  const mp4 = path.join(run.out, 'M1.mp4')
  const t0 = lineAt(run.log, /^scene M1 step 0 /).at
  const typingAt = (lineAt(run.log, /^scene M1 step 2 /).at - t0) / 1000
  const typingSec = (PROMO.length * 200) / 1000
  const field = { x: 100, y: 300, width: 400, height: 40 }
  for (const t of [typingAt + 0.4, typingAt + typingSec / 2, typingAt + typingSec - 0.2]) {
    const frame = frameAt(mp4, t)
    const { off, pixels } = offPixels(frame, field, [0, 0, 0], 24)
    assert.equal(off, 0, `#promo at ${t.toFixed(2)} s: ${off} of ${pixels} pixels are not mask fill`)
    assert.ok(offPixels(frame, { x: 0, y: 0, width: 1920, height: 80 }, [0, 0, 0], 24).off > 0, 'the whole frame is mask fill')
  }
})

function frameAt(mp4, sec) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', sec.toFixed(3), '-i', mp4, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 32 * 1024 * 1024 })
  assert.equal(raw.length, PROD_VIEWPORT.width * PROD_VIEWPORT.height * 3, `no frame at ${sec}s`)
  return raw
}

// Pixels inside the box (inset 2 px for the encoder's soft edges) more than
// `tol` off `rgb` on any channel.
function offPixels(frame, box, rgb, tol) {
  let off = 0
  let pixels = 0
  for (let y = box.y + 2; y < box.y + box.height - 2; y++) {
    for (let x = box.x + 2; x < box.x + box.width - 2; x++) {
      const i = (y * PROD_VIEWPORT.width + x) * 3
      pixels += 1
      if (rgb.some((v, c) => Math.abs(frame[i + c] - v) > tol)) off += 1
    }
  }
  return { off, pixels }
}

test('guardrail 3: *.profile/ dirs and recordings/ are gitignored', () => {
  for (const p of ['some.profile/', 'parvati.profile/Default/Cookies', 'recordings/x.mp4']) {
    assert.equal(spawnSync('git', ['check-ignore', '-q', p], { cwd: REPO_ROOT }).status, 0, `${p} is not ignored`)
  }
})

contractTest('guardrail 4: --production refuses any base but https://shoreward.ai or loopback (not 3001), before any browser', async () => {
  scene('R2', [{ action: 'pause', ms: 200 }])
  for (const base of ['https://example.com', 'https://shoreward.ai.evil.com', 'http://127.0.0.1:3001', 'http://LOCALHOST:5490', 'http://localhost@example.com:5490']) {
    const run = await production(['--scene', 'R2'], { base, profile: profileDir() })
    assert.equal(run.code, 1, `${base}: ${run.stderr}`)
    assert.match(run.stderr, /production refused --production/, base)
    assert.doesNotMatch(run.stdout, /launch/, base)
    assert.equal(existsSync(run.out), false, `${base}: --out was made`)
  }
})
