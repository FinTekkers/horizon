// HZ-622: the shared, keyed root-base UI build (ensure-build.mjs). Every case
// runs against a tiny ui/ + domain/ tree in a temp dir, with a fake build (in
// process) or a fake node_modules/.bin/vite (for the CLI), never real Vite.
// HZ-671: that build lives in ui/dist-local; ui/dist is the production build
// and must come through every case untouched.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { computeKey, ensureBuild, KEY_FILE, LOCK_FILE, OUT_DIR, readKey } from './ensure-build.mjs'

const HERE = import.meta.dirname
const REPO_ROOT = path.resolve(HERE, '../..')
const BUILD_ENV_VARS = ['HORIZON_BASE', 'HORIZON_E2E_COVERAGE_DIR', 'VITE_PROXY_TARGET']

// The env of a normal check run: none of the build-env vars set.
function plainEnv(extra = {}) {
  const env = { ...process.env }
  for (const name of BUILD_ENV_VARS) delete env[name]
  return { ...env, ...extra }
}

const FAKE_VITE = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const outDir = process.argv[process.argv.indexOf('--outDir') + 1]
if (process.env.FAKE_VITE_COUNTER) fs.appendFileSync(process.env.FAKE_VITE_COUNTER, 'x')
const ms = Number(process.env.FAKE_VITE_SLEEP_MS || 0)
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
if (process.env.FAKE_VITE_FAIL) process.exit(1)
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'index.html'), 'built by fake vite ' + process.pid)
`

function makeTree() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ensure-build-'))
  const ui = path.join(root, 'ui')
  const domain = path.join(root, 'domain')
  mkdirSync(path.join(ui, 'src'), { recursive: true })
  mkdirSync(path.join(ui, 'scripts'))
  mkdirSync(path.join(ui, 'node_modules/.bin'), { recursive: true })
  mkdirSync(domain)
  writeFileSync(path.join(ui, 'src/x.js'), 'export const x = 1\n')
  writeFileSync(path.join(ui, 'index.html'), '<div id="root"></div>\n')
  writeFileSync(path.join(ui, 'package-lock.json'), '{}\n')
  writeFileSync(path.join(ui, 'vite.config.js'), 'export default {}\n')
  writeFileSync(path.join(domain, 'steps.json'), '[]\n')
  copyFileSync(path.join(HERE, 'ensure-build.mjs'), path.join(ui, 'scripts/ensure-build.mjs'))
  writeFileSync(path.join(ui, 'node_modules/.bin/vite'), FAKE_VITE)
  chmodSync(path.join(ui, 'node_modules/.bin/vite'), 0o755)
  return { root, ui, domain, dist: path.join(ui, OUT_DIR), prodDist: path.join(ui, 'dist'), counter: path.join(root, 'counter') }
}

function fakeBuild() {
  const calls = []
  const build = async (outDir, env) => {
    calls.push({ outDir, env })
    mkdirSync(outDir, { recursive: true })
    writeFileSync(path.join(outDir, 'index.html'), `build ${calls.length}`)
  }
  return { build, calls }
}

const quiet = () => {}

function run(tree, opts = {}) {
  return ensureBuild({ uiDir: tree.ui, domainDir: tree.domain, env: plainEnv(), log: quiet, ...opts })
}

function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid
}

function leftovers(ui) {
  return readdirSync(ui).filter((n) => n.startsWith('.dist-local-tmp-') || n.startsWith('.dist-local-old-') || n === LOCK_FILE)
}

// --- in-process -------------------------------------------------------------

test('a second run on an unchanged tree skips the build and leaves ui/dist-local and its key untouched', async (t) => {
  const tree = makeTree()
  t.after(() => rmSync(tree.root, { recursive: true, force: true }))
  const { build, calls } = fakeBuild()

  const first = await run(tree, { build })
  assert.equal(first.built, true)
  const distMtime = statSync(tree.dist).mtimeMs
  const keyStat = statSync(path.join(tree.dist, KEY_FILE))
  const keyText = readFileSync(path.join(tree.dist, KEY_FILE), 'utf8')

  const second = await run(tree, { build })
  assert.equal(second.built, false)
  assert.equal(second.key, first.key)
  assert.equal(calls.length, 1)
  assert.equal(statSync(tree.dist).mtimeMs, distMtime)
  assert.equal(statSync(path.join(tree.dist, KEY_FILE)).mtimeMs, keyStat.mtimeMs)
  assert.equal(statSync(path.join(tree.dist, KEY_FILE)).ino, keyStat.ino)
  assert.equal(readFileSync(path.join(tree.dist, KEY_FILE), 'utf8'), keyText)
  assert.equal(readFileSync(path.join(tree.dist, 'index.html'), 'utf8'), 'build 1')
})

test('changing a file under ui/src between runs rebuilds and writes a new key', async (t) => {
  const tree = makeTree()
  t.after(() => rmSync(tree.root, { recursive: true, force: true }))
  const { build, calls } = fakeBuild()

  const first = await run(tree, { build })
  writeFileSync(path.join(tree.ui, 'src/x.js'), 'export const x = 2\n')
  const second = await run(tree, { build })

  assert.equal(second.built, true)
  assert.equal(calls.length, 2)
  assert.notEqual(second.key, first.key)
  assert.equal(readKey(tree.dist), second.key)
  assert.equal(readFileSync(path.join(tree.dist, 'index.html'), 'utf8'), 'build 2')
})

test('a change under domain/ rebuilds too: the UI imports it from outside ui/', async (t) => {
  const tree = makeTree()
  t.after(() => rmSync(tree.root, { recursive: true, force: true }))
  const { build, calls } = fakeBuild()

  await run(tree, { build })
  writeFileSync(path.join(tree.domain, 'steps.json'), '[{"id":"a"}]\n')
  assert.equal((await run(tree, { build })).built, true)
  assert.equal(calls.length, 2)
})

test('the e2e webServer env and the serve.sh env give the same key', () => {
  const tree = makeTree()
  try {
    // e2e/playwright.config.js: the inherited env plus a per-run proxy target.
    const webServer = { ...plainEnv(), VITE_PROXY_TARGET: 'http://localhost:3123' }
    // e2e/screenshots/serve.sh: `env -u HORIZON_BASE -u HORIZON_E2E_COVERAGE_DIR -u VITE_PROXY_TARGET`.
    const serveSh = { ...webServer }
    for (const name of BUILD_ENV_VARS) delete serveSh[name]
    const a = computeKey({ uiDir: tree.ui, domainDir: tree.domain, env: webServer })
    const b = computeKey({ uiDir: tree.ui, domainDir: tree.domain, env: serveSh })
    assert.equal(a.key, b.key)
  } finally {
    rmSync(tree.root, { recursive: true, force: true })
  }
})

test('the proxy target never reaches the build env', async (t) => {
  const tree = makeTree()
  t.after(() => rmSync(tree.root, { recursive: true, force: true }))
  const { build, calls } = fakeBuild()
  await run(tree, { build, env: plainEnv({ VITE_PROXY_TARGET: 'http://localhost:1', VITE_MOCK: '1' }) })
  assert.equal(calls[0].env.VITE_PROXY_TARGET, undefined)
  assert.equal(calls[0].env.VITE_MOCK, '1')
})

test('a plain build never reuses a coverage or /horizon/ build, or the other way round', async (t) => {
  const cases = [
    { name: 'coverage', env: { HORIZON_E2E_COVERAGE_DIR: '/tmp/cov' } },
    { name: 'HORIZON_BASE=/horizon/', env: { HORIZON_BASE: '/horizon/' } },
  ]
  for (const c of cases) {
    await t.test(c.name, async () => {
      const tree = makeTree()
      try {
        const { build, calls } = fakeBuild()
        const plain = await run(tree, { build })
        const variant = await run(tree, { build, env: plainEnv(c.env) })
        assert.equal(variant.built, true, `a ${c.name} build reused the plain build`)
        assert.notEqual(variant.key, plain.key)
        const back = await run(tree, { build })
        assert.equal(back.built, true, `a plain build reused the ${c.name} build`)
        assert.equal(back.key, plain.key)
        assert.equal(calls.length, 3)
      } finally {
        rmSync(tree.root, { recursive: true, force: true })
      }
    })
  }
})

test('a failed build writes no key, leaves the old ui/dist-local alone and no temp dir behind', async (t) => {
  const tree = makeTree()
  t.after(() => rmSync(tree.root, { recursive: true, force: true }))
  const good = await run(tree, fakeBuild())
  writeFileSync(path.join(tree.ui, 'src/x.js'), 'export const x = 3\n')

  const failing = async (outDir) => {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(path.join(outDir, 'index.html'), 'half-written')
    throw new Error('vite build exited 1')
  }
  await assert.rejects(run(tree, { build: failing }), /vite build exited 1/)

  assert.equal(readKey(tree.dist), good.key, 'the old build and its key must be untouched')
  assert.equal(readFileSync(path.join(tree.dist, 'index.html'), 'utf8'), 'build 1')
  assert.deepEqual(leftovers(tree.ui), [])
  // And the next run does not take the old build for the new tree.
  assert.equal((await run(tree, fakeBuild())).built, true)
})

test('an interrupted builder’s leftovers are ignored by the key and never promoted', async (t) => {
  const tree = makeTree()
  t.after(() => rmSync(tree.root, { recursive: true, force: true }))
  const before = computeKey({ uiDir: tree.ui, domainDir: tree.domain, env: plainEnv() }).key

  const pid = deadPid()
  const tmp = path.join(tree.ui, `.dist-local-tmp-${pid}`)
  mkdirSync(tmp)
  writeFileSync(path.join(tmp, 'index.html'), 'from the killed builder')
  // A valid-looking key: even this must not get the dir promoted.
  writeFileSync(path.join(tmp, KEY_FILE), JSON.stringify({ key: before }))
  mkdirSync(path.join(tree.ui, `.dist-local-old-${pid}`))
  writeFileSync(path.join(tree.ui, `.dist-local-old-${pid}`, 'index.html'), 'old')
  writeFileSync(path.join(tree.ui, LOCK_FILE), String(pid))

  assert.equal(computeKey({ uiDir: tree.ui, domainDir: tree.domain, env: plainEnv() }).key, before)
  const { build, calls } = fakeBuild()
  const result = await run(tree, { build, lockWaitMs: 2_000 })
  assert.equal(result.built, true)
  assert.equal(result.key, before)
  assert.equal(calls.length, 1)
  assert.equal(readFileSync(path.join(tree.dist, 'index.html'), 'utf8'), 'build 1')
  assert.deepEqual(leftovers(tree.ui), [], 'the stale lock and the dead builder’s dirs are cleared')
})

test('a corrupt key file rebuilds instead of crashing', async (t) => {
  const tree = makeTree()
  t.after(() => rmSync(tree.root, { recursive: true, force: true }))
  mkdirSync(tree.dist)
  writeFileSync(path.join(tree.dist, KEY_FILE), 'not json')
  assert.equal((await run(tree, fakeBuild())).built, true)
})

test('HZ-622 leftovers and a production ui/dist never change the key', () => {
  const tree = makeTree()
  try {
    const key = () => computeKey({ uiDir: tree.ui, domainDir: tree.domain, env: plainEnv() }).key
    const before = key()
    writeFileSync(path.join(tree.ui, '.build.lock'), '1')
    mkdirSync(path.join(tree.ui, '.dist-tmp-1'))
    writeFileSync(path.join(tree.ui, '.dist-tmp-1/index.html'), 'tmp')
    mkdirSync(path.join(tree.ui, '.dist-old-1'))
    writeFileSync(path.join(tree.ui, '.dist-old-1/index.html'), 'old')
    mkdirSync(tree.prodDist)
    writeFileSync(path.join(tree.prodDist, 'index.html'), '<script src="/horizon/assets/a.js"></script>')
    assert.equal(key(), before)
  } finally {
    rmSync(tree.root, { recursive: true, force: true })
  }
})

// --- CLI --------------------------------------------------------------------

function cliEnv(tree, extra = {}) {
  return plainEnv({ FAKE_VITE_COUNTER: tree.counter, ...extra })
}

function runCli(tree, extra) {
  return spawnSync(process.execPath, ['scripts/ensure-build.mjs'], { cwd: tree.ui, env: cliEnv(tree, extra), encoding: 'utf8' })
}

function count(tree) {
  return existsSync(tree.counter) ? readFileSync(tree.counter, 'utf8').length : 0
}

test('CLI: the first run logs building, the second logs reusing without running vite, a failed build exits non-zero', (t) => {
  const tree = makeTree()
  t.after(() => rmSync(tree.root, { recursive: true, force: true }))

  const first = runCli(tree)
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /ensure-build: building ui\/dist-local \(key [0-9a-f]{12}\)/)
  assert.equal(count(tree), 1)
  assert.ok(existsSync(path.join(tree.dist, 'index.html')))

  const second = runCli(tree)
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /ensure-build: reusing ui\/dist-local \(key [0-9a-f]{12}\)/)
  assert.doesNotMatch(second.stdout, /ensure-build: building/)
  assert.equal(count(tree), 1)

  writeFileSync(path.join(tree.ui, 'src/x.js'), 'export const x = 4\n')
  const failed = runCli(tree, { FAKE_VITE_FAIL: '1' })
  assert.notEqual(failed.status, 0)
  assert.match(failed.stderr, /ensure-build: vite build exited 1/)
  assert.deepEqual(leftovers(tree.ui), [])
})

function spawnCli(tree, extra) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/ensure-build.mjs'], { cwd: tree.ui, env: cliEnv(tree, extra) })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

test('CLI: two processes at once build once, and both exit 0 with the same key', async (t) => {
  const tree = makeTree()
  t.after(() => rmSync(tree.root, { recursive: true, force: true }))

  const results = await Promise.all([spawnCli(tree, { FAKE_VITE_SLEEP_MS: '500' }), spawnCli(tree, { FAKE_VITE_SLEEP_MS: '500' })])
  for (const r of results) assert.equal(r.status, 0, r.stderr)
  assert.equal(count(tree), 1, 'vite ran more than once')
  const keys = results.map((r) => /ensure-build: (?:building|reusing) ui\/dist-local \(key ([0-9a-f]{12})\)/.exec(r.stdout)?.[1])
  assert.ok(keys[0], results[0].stdout)
  assert.equal(keys[0], keys[1])
  assert.equal(results.filter((r) => /ensure-build: building/.test(r.stdout)).length, 1)
  assert.deepEqual(leftovers(tree.ui), [])
})

// --- HZ-671: ui/dist is the production build ---------------------------------

// Every entry under dir: relative path, kind, bytes and mtimeMs. Deep-equal
// snapshots mean nothing was added, removed, rewritten or touched.
function snapshot(dir) {
  const out = []
  const walk = (sub) => {
    for (const entry of readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = path.join(sub, entry.name)
      const full = path.join(dir, rel)
      const { mtimeMs } = statSync(full)
      if (entry.isDirectory()) {
        out.push({ rel, kind: 'dir', mtimeMs })
        walk(rel)
      } else {
        out.push({ rel, kind: 'file', bytes: readFileSync(full).toString('base64'), mtimeMs })
      }
    }
  }
  walk('')
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

// A deploy checkout: a /horizon/ production build in ui/dist, with an old
// HZ-622 key inside it, and HZ-622's lock and dead temp dirs beside it.
function seedProduction(tree, { key = 'an-old-root-base-key' } = {}) {
  const pid = deadPid()
  mkdirSync(path.join(tree.prodDist, 'assets'), { recursive: true })
  writeFileSync(path.join(tree.prodDist, 'index.html'), '<script type="module" src="/horizon/assets/a.js"></script>\n')
  writeFileSync(path.join(tree.prodDist, 'assets/a.js'), 'console.log("live")\n')
  writeFileSync(path.join(tree.prodDist, KEY_FILE), JSON.stringify({ key }))
  writeFileSync(path.join(tree.ui, '.build.lock'), String(pid))
  for (const prefix of ['.dist-tmp-', '.dist-old-']) {
    mkdirSync(path.join(tree.ui, `${prefix}${pid}`))
    writeFileSync(path.join(tree.ui, `${prefix}${pid}`, 'index.html'), prefix)
  }
  return pid
}

test('CLI: the build lands in ui/dist-local and ui/dist and the HZ-622 leftovers stay byte-for-byte unchanged', (t) => {
  const tree = makeTree()
  t.after(() => rmSync(tree.root, { recursive: true, force: true }))
  const pid = seedProduction(tree)
  const legacy = ['.build.lock', `.dist-tmp-${pid}`, `.dist-old-${pid}`]
  const before = snapshot(tree.prodDist)
  const legacyBefore = legacy.map((name) => (statSync(path.join(tree.ui, name)).isDirectory() ? snapshot(path.join(tree.ui, name)) : readFileSync(path.join(tree.ui, name), 'utf8')))

  const result = runCli(tree)
  assert.equal(result.status, 0, result.stderr)
  assert.ok(existsSync(path.join(tree.dist, 'index.html')), 'no ui/dist-local/index.html')
  assert.ok(existsSync(path.join(tree.dist, KEY_FILE)), 'no ui/dist-local/.build-key')
  assert.deepEqual(snapshot(tree.prodDist), before, 'ui/dist changed')
  const legacyAfter = legacy.map((name) => (statSync(path.join(tree.ui, name)).isDirectory() ? snapshot(path.join(tree.ui, name)) : readFileSync(path.join(tree.ui, name), 'utf8')))
  assert.deepEqual(legacyAfter, legacyBefore, 'an HZ-622 leftover was removed or rewritten')
  assert.deepEqual(leftovers(tree.ui), [])
})

test('CLI: a current key inside ui/dist is not reused; the first run still builds ui/dist-local', (t) => {
  const tree = makeTree()
  t.after(() => rmSync(tree.root, { recursive: true, force: true }))
  const { key } = computeKey({ uiDir: tree.ui, domainDir: tree.domain, env: cliEnv(tree) })
  seedProduction(tree, { key })
  const before = snapshot(tree.prodDist)

  const result = runCli(tree)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /ensure-build: building ui\/dist-local \(key [0-9a-f]{12}\)/)
  assert.doesNotMatch(result.stdout, /ensure-build: reusing/)
  assert.equal(count(tree), 1)
  assert.equal(readKey(tree.dist), key)
  assert.ok(existsSync(path.join(tree.dist, 'index.html')))
  assert.deepEqual(snapshot(tree.prodDist), before)
})

test('CLI: a production build into ui/dist between runs does not stop ui/dist-local being reused', (t) => {
  const tree = makeTree()
  t.after(() => rmSync(tree.root, { recursive: true, force: true }))
  assert.equal(runCli(tree).status, 0)
  // What `npm run build` or the deploy leaves behind.
  mkdirSync(path.join(tree.prodDist, 'assets'), { recursive: true })
  writeFileSync(path.join(tree.prodDist, 'index.html'), '<script type="module" src="/horizon/assets/b.js"></script>\n')

  const second = runCli(tree)
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /ensure-build: reusing ui\/dist-local \(key [0-9a-f]{12}\)/)
  assert.equal(count(tree), 1)
})

// --- wiring -----------------------------------------------------------------

// HZ-671: every local server that builds and serves the UI. A new one must be
// listed here too, so it cannot build or serve the production ui/dist.
const LOCAL_SERVERS = ['scripts/recorder/serve-walkthrough.sh', 'e2e/screenshots/serve.sh', 'e2e/playwright.config.js']

// The file without its comment lines (# for shell, // for JS): the comments
// explain ui/dist, and only the commands count.
function commands(file) {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(?:#|\/\/)/.test(line))
    .join('\n')
}

test('the local servers build through ensure-build.mjs and serve ui/dist-local, never ui/dist', () => {
  for (const file of LOCAL_SERVERS) {
    const text = commands(file)
    assert.match(text, /node scripts\/ensure-build\.mjs/, `${file} does not call ensure-build.mjs`)
    const previews = text.split('\n').filter((line) => /vite preview/.test(line))
    assert.ok(previews.length > 0, `${file} runs no vite preview`)
    for (const line of previews) assert.match(line, /--outDir\s+dist-local\b/, `${file}: ${line.trim()}`)
    assert.doesNotMatch(text, /--outDir\s+dist(?![-\w])/, `${file} names --outDir dist`)
    assert.doesNotMatch(text, /\bui\/dist(?![-\w])/, `${file} names ui/dist`)
    assert.doesNotMatch(text, /npm run build/, `${file} still runs npm run build`)
    assert.doesNotMatch(text, /vite build/, `${file} still runs vite build itself`)
  }
  assert.match(commands('e2e/screenshots/serve.sh'), /^\(cd "\$ROOT\/ui" && env -u HORIZON_BASE -u HORIZON_E2E_COVERAGE_DIR -u VITE_PROXY_TARGET node scripts\/ensure-build\.mjs\) 9>&-$/m)
})

test('git ignores ui/dist-local and its lock and temp dirs', () => {
  const paths = ['ui/dist-local/index.html', 'ui/.dist-local.lock', 'ui/.dist-local-tmp-1/', 'ui/.dist-local-old-1/']
  for (const p of paths) {
    const r = spawnSync('git', ['check-ignore', '-q', p], { cwd: REPO_ROOT })
    assert.equal(r.status, 0, `git check-ignore ${p} exited ${r.status}`)
  }
})

test('the production build still writes ui/dist with the /horizon/ base', () => {
  const verify = readFileSync(path.join(HERE, 'verify-base-build.mjs'), 'utf8')
  assert.match(verify, /path\.join\(REPO_ROOT, 'ui\/dist'\)/)
  assert.match(verify, /HORIZON_BASE: '\/horizon\/'/)
  const deploy = readFileSync(path.join(REPO_ROOT, 'infra/host/deploy-horizon.sh'), 'utf8')
  assert.match(deploy, /HORIZON_BASE=\/horizon\/ npm run build/)
  assert.match(deploy, /grep -q '\/horizon\/assets\/' ui\/dist\/index\.html/)
})

test('verify-base-build.mjs wipes ui/dist, and so its key, before its /horizon/ build', () => {
  const src = readFileSync(path.join(HERE, 'verify-base-build.mjs'), 'utf8')
  const wipe = src.indexOf('rmSync(DIST')
  const build = src.indexOf("spawnSync('npm'")
  assert.ok(wipe !== -1, 'verify-base-build.mjs no longer wipes ui/dist')
  assert.ok(build !== -1, 'verify-base-build.mjs no longer runs its build with spawnSync')
  assert.ok(wipe < build, 'the wipe must come before the build, or a stale root-base key could survive it')
})
