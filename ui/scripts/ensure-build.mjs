// HZ-622: builds ui/dist once per tree and reuses it. The e2e webServer
// (e2e/playwright.config.js), spec 53's serve.sh and the screenshot slot's
// serve.sh all used to run their own identical root-base `npm run build`
// (about 1.8s each on an idle host, plus npm's start-up). Now they call this
// script. The first one builds, and every later caller with the same key
// reuses that build.
//
// The key is a sha256 over every file under ui/ (except build output and
// node_modules, which package-lock.json stands for), every file under domain/
// (the UI imports it from outside its Vite root), and the build env: base,
// coverage sourcemaps, NODE_ENV, the Node version and every VITE_* var.
// VITE_PROXY_TARGET is left out and stripped from the build env. Only the
// dev/preview proxy reads it, and e2e sets a per-run port, so keying on it
// would make every caller miss.
//
// Why the key lives INSIDE ui/dist (ui/dist/.build-key) and not beside it:
// anything else that writes ui/dist wipes it. That covers verify-base-build.mjs
// (rmSync before its /horizon/ build), deploy-horizon.sh and any manual
// `npm run build` (Vite's emptyOutDir removes dotfiles too). So no key can
// outlive the build it describes. A build is promoted with one rename that
// carries the key with it.
//
// A failed or interrupted build is never reused. It builds into
// ui/.dist-tmp-<pid>, writes the key only after vite exits 0, and only then
// swaps the dir into ui/dist. A lock (ui/.build.lock, holding the builder's
// pid) keeps a second caller from building at the same time. The second caller
// waits, then re-reads the key. A lock whose pid is dead is stale and is
// removed.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const KEY_FILE = '.build-key'
export const LOCK_FILE = '.build.lock'
const TMP_PREFIX = '.dist-tmp-'
const OLD_PREFIX = '.dist-old-'
const DEFAULT_LOCK_WAIT_MS = 120_000
const LOCK_POLL_MS = 200
// A lock file with no pid yet (its writer died between open and write) counts
// as stale once it is this old.
const EMPTY_LOCK_STALE_MS = 10_000
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'coverage'])
const ENV_NOT_IN_BUILD = ['VITE_PROXY_TARGET']

function isExcluded(name, isDir) {
  if (isDir && EXCLUDED_DIRS.has(name)) return true
  if (name.startsWith(TMP_PREFIX) || name.startsWith(OLD_PREFIX) || name === LOCK_FILE) return true
  // Vite bundles its config to a temp file beside it while it runs.
  return /\.timestamp-[^/]*\.mjs$/.test(name)
}

function listFiles(root, { exclude } = {}) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const isDir = entry.isDirectory()
      if (dir === root && exclude?.(entry.name, isDir)) continue
      if (dir !== root && isDir && entry.name === 'node_modules') continue
      const full = path.join(dir, entry.name)
      if (isDir) walk(full)
      else out.push(full)
    }
  }
  walk(root)
  return out.sort()
}

function hashTree(hash, label, root, opts) {
  for (const file of listFiles(root, opts)) {
    const rel = path.relative(root, file).split(path.sep).join('/')
    hash.update(`${label}/${rel}\0`)
    let st
    try {
      st = statSync(file)
    } catch {
      // A dangling symlink: key on where it points.
      hash.update(`link:${readlinkSync(file)}\0`)
      continue
    }
    if (st.isFile()) hash.update(readFileSync(file))
    hash.update('\0')
  }
}

export function buildEnv(env) {
  const out = { ...env }
  for (const name of ENV_NOT_IN_BUILD) delete out[name]
  return out
}

export function computeKey({ uiDir, domainDir, env = process.env }) {
  const vite = {}
  for (const name of Object.keys(env).sort()) {
    if (name.startsWith('VITE_') && !ENV_NOT_IN_BUILD.includes(name)) vite[name] = env[name]
  }
  const inputs = {
    base: env.HORIZON_BASE || '/',
    coverage: Boolean(env.HORIZON_E2E_COVERAGE_DIR),
    nodeEnv: env.NODE_ENV ?? null,
    node: process.version,
    vite,
  }
  const hash = createHash('sha256')
  hash.update(JSON.stringify(inputs))
  hash.update('\0')
  // Only top-level build output is skipped; a src/dist/ would still count.
  hashTree(hash, 'ui', uiDir, { exclude: isExcluded })
  if (existsSync(domainDir)) hashTree(hash, 'domain', domainDir)
  return { key: hash.digest('hex'), inputs }
}

export function readKey(distDir) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(distDir, KEY_FILE), 'utf8'))
    return typeof parsed?.key === 'string' ? parsed.key : null
  } catch {
    return null
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function readLock(lockPath) {
  try {
    const text = readFileSync(lockPath, 'utf8').trim()
    const st = statSync(lockPath)
    return { text, pid: /^\d+$/.test(text) ? Number(text) : null, ageMs: Date.now() - st.mtimeMs }
  } catch {
    return null
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function acquireLock(lockPath, { lockWaitMs, log }) {
  const deadline = Date.now() + lockWaitMs
  let reportedHolder = null
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    const held = readLock(lockPath)
    if (held) {
      const stale = held.pid === null ? held.ageMs > EMPTY_LOCK_STALE_MS : !pidAlive(held.pid)
      if (stale) {
        // Re-read just before removing, so a lock a live caller took in the
        // meantime is left alone.
        if (readLock(lockPath)?.text === held.text) {
          log(`ensure-build: removing stale lock (pid ${held.pid ?? 'none'} is gone)`)
          try {
            unlinkSync(lockPath)
          } catch {}
        }
        continue
      }
      if (reportedHolder !== held.pid) {
        log(`ensure-build: waiting for pid ${held.pid ?? 'unknown'} to finish building ui/dist`)
        reportedHolder = held.pid
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${lockWaitMs}ms waiting for ${LOCK_FILE} (held by pid ${held?.pid ?? 'unknown'})`)
    }
    await sleep(LOCK_POLL_MS)
  }
}

function releaseLock(lockPath) {
  if (readLock(lockPath)?.pid === process.pid) {
    try {
      unlinkSync(lockPath)
    } catch {}
  }
}

// Leftovers of a builder that was killed mid-run. They are never promoted, and
// the key ignores them; this only reclaims the disk. Called under the lock.
function removeDeadLeftovers(uiDir) {
  for (const name of readdirSync(uiDir)) {
    const m = /^\.dist-(?:tmp|old)-(\d+)$/.exec(name)
    if (m && (Number(m[1]) === process.pid || !pidAlive(Number(m[1])))) {
      rmSync(path.join(uiDir, name), { recursive: true, force: true })
    }
  }
}

export function viteBuild(uiDir) {
  return (outDir, env) =>
    new Promise((resolve, reject) => {
      const child = spawn(path.join(uiDir, 'node_modules/.bin/vite'), ['build', '--outDir', outDir, '--emptyOutDir'], {
        cwd: uiDir,
        env,
        stdio: 'inherit',
      })
      child.on('error', reject)
      child.on('close', (code, signal) => {
        if (code === 0) resolve()
        else reject(new Error(`vite build exited ${signal ?? code}`))
      })
    })
}

export async function ensureBuild({
  uiDir,
  domainDir = path.join(uiDir, '../domain'),
  env = process.env,
  build = viteBuild(uiDir),
  log = console.log,
  lockWaitMs = DEFAULT_LOCK_WAIT_MS,
  onTmpDir = () => {},
}) {
  const distDir = path.join(uiDir, 'dist')
  const lockPath = path.join(uiDir, LOCK_FILE)
  const { key, inputs } = computeKey({ uiDir, domainDir, env })
  const reuse = () => {
    if (readKey(distDir) !== key) return false
    log(`ensure-build: reusing ui/dist (key ${key.slice(0, 12)})`)
    return true
  }
  if (reuse()) return { built: false, key }

  await acquireLock(lockPath, { lockWaitMs, log })
  const tmpDir = path.join(uiDir, `${TMP_PREFIX}${process.pid}`)
  const oldDir = path.join(uiDir, `${OLD_PREFIX}${process.pid}`)
  try {
    // A concurrent caller may have built this key while we waited.
    if (reuse()) return { built: false, key }
    removeDeadLeftovers(uiDir)
    log(`ensure-build: building ui/dist (key ${key.slice(0, 12)})`)
    onTmpDir(tmpDir)
    try {
      await build(tmpDir, buildEnv(env))
    } catch (err) {
      rmSync(tmpDir, { recursive: true, force: true })
      throw err
    }
    // The key is written last, so a dir without it was never a finished build.
    writeFileSync(path.join(tmpDir, KEY_FILE), `${JSON.stringify({ key, inputs }, null, 2)}\n`)
    if (existsSync(distDir)) renameSync(distDir, oldDir)
    renameSync(tmpDir, distDir)
    rmSync(oldDir, { recursive: true, force: true })
    return { built: true, key }
  } finally {
    releaseLock(lockPath)
  }
}

async function main() {
  const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const lockPath = path.join(uiDir, LOCK_FILE)
  let tmpDir = null
  // serve.sh's runner SIGTERMs the whole group mid-build. Clean up rather
  // than leave the lock and a half-written dir for the next caller to clear.
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
    process.on(signal, () => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
      releaseLock(lockPath)
      process.exit(code)
    })
  }
  try {
    await ensureBuild({ uiDir, onTmpDir: (dir) => (tmpDir = dir) })
  } catch (err) {
    console.error(`ensure-build: ${err.message}`)
    process.exit(1)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
