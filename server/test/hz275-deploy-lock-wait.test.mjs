// HZ-275 metric 5: two releases published close together both deploy, in
// order. On 2026-10-02 deploy-hz-264 lost the lock to deploy-hz-263 and
// needed a manual re-run. A deploy the server starts now waits for a held lock
// for up to 30 minutes (server/src/config.js sets HORIZON_DEPLOY_LOCK_TIMEOUT_S,
// which spawnEnv hands to the script and the script already reads; an
// explicit value still wins). The scripts themselves stay unchanged:
// deploy-dry-run.test.mjs (HZ-258) requires infra/host/ and deploy.js to match
// main, and metric 4 forbids editing that test.
//
// Same approach as infra/host/test/deploy.test.sh: the real deploy-horizon.sh
// against a throwaway git repo, with npm, sudo, systemctl and curl stubbed on
// PATH, run with the env spawnEnv builds. git and flock are real. flock is
// wrapped only to report whether deploy B found the lock held, and with what
// bound. Fifos sequence the two deploys (A holds the lock, B finds it held,
// then A goes on), so nothing sleeps.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { constants, chmodSync, mkdtempSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// No real HORIZON_* setting or FARM_HOME reaches the scripts.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('HORIZON_') || key === 'FARM_HOME') delete process.env[key]
}
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-hz275-lock-home-')) // spawnEnv's state dir
process.env.HORIZON_DB = join(process.env.HOME, 'test.db')

const { DEPLOY_LOCK_TIMEOUT_S } = await import('../src/config.js')
const { spawnEnv } = await import('../src/deploy.js')

const HOST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'infra', 'host')
const DEPLOY_HORIZON_SH = join(HOST_DIR, 'deploy-horizon.sh')
const DEPLOY_UI_SERVICE_SH = join(HOST_DIR, 'deploy-ui-service.sh')
const REPO_ROOT = join(HOST_DIR, '..', '..')
const REAL_FLOCK = execFileSync('bash', ['-c', 'command -v flock'], { encoding: 'utf8' }).trim()

function stub(dir, name, body) {
  writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(join(dir, name), 0o755)
}

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

// A bare upstream with tags v-a and v-b on two different commits, and the
// clone the deploy script fetches into and checks out.
function setupRepo(base) {
  const upstream = join(base, 'upstream.git')
  const seed = join(base, 'seed')
  git(base, 'init', '--quiet', '--bare', upstream)
  git(base, 'clone', '--quiet', upstream, seed)
  git(seed, 'checkout', '--quiet', '-b', 'main')
  git(seed, 'config', 'user.email', 'test@example.com')
  git(seed, 'config', 'user.name', 'Deploy Test')
  mkdirSync(join(seed, 'server'))
  mkdirSync(join(seed, 'ui'))
  writeFileSync(join(seed, 'server', 'package.json'), '{"name":"server-stub"}\n')
  writeFileSync(join(seed, 'ui', 'package.json'), '{"name":"ui-stub"}\n')
  for (const tag of ['v-a', 'v-b']) {
    writeFileSync(join(seed, 'VERSION'), `${tag}\n`)
    git(seed, 'add', '-A')
    git(seed, 'commit', '--quiet', '-m', tag)
    git(seed, 'tag', tag)
  }
  git(seed, 'push', '--quiet', 'origin', 'main', '--tags')
  git(base, 'clone', '--quiet', upstream, join(base, 'repo'))
  return join(base, 'repo')
}

function runDeploy(script, tag, env) {
  const child = spawn('bash', [script, tag], { env, stdio: 'ignore', detached: true })
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  return { child, exited }
}

test('a deploy that finds the lock held waits for it, and both log DEPLOY OK in order', { timeout: 60_000 }, async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'horizon-hz275-lock-'))
  const stubs = join(base, 'stubs')
  mkdirSync(stubs)
  const repo = setupRepo(base)
  // A target like the server's own, minus the drain (no server to drain).
  const target = { key: 'horizon-test', repoDir: repo, stateKey: 'horizon-test', service: 'horizon-server-test', healthUrl: 'http://stub.invalid/api/health' }
  const state = join(process.env.HOME, '.horizon', 'horizon-test')
  const inBuild = join(base, 'in-build')
  const release = join(base, 'release')
  const flockReport = join(base, 'flock-report')
  execFileSync('mkfifo', [inBuild, release, flockReport])

  stub(stubs, 'sudo', 'exec "$@"')
  stub(stubs, 'systemctl', 'exit 0')
  stub(stubs, 'curl', `printf '%s' '{"ok":true,"itemCount":1}'`)
  // Deploy A (HOLD_DIR set) stops inside its build, holding the lock, until
  // the test writes to the release fifo.
  stub(
    stubs,
    'npm',
    `if [ -n "\${HOLD_DIR:-}" ] && [ ! -e "$HOLD_DIR/held-once" ]; then
  : >"$HOLD_DIR/held-once"
  echo in-build >"$HOLD_DIR/in-build"
  read -r _ <"$HOLD_DIR/release"
fi
if [ "$1" = "run" ] && [ "$2" = "build" ]; then
  mkdir -p dist
  printf '<script type="module" src="%sassets/index.js"></script>\\n' "\${HORIZON_BASE:-/}" >dist/index.html
fi
exit 0`,
  )
  // Deploy B (FLOCK_REPORT set) reports whether the lock was already held
  // and the bound it waits with, then runs the real flock.
  stub(
    stubs,
    'flock',
    `if [ -n "\${FLOCK_REPORT:-}" ]; then
  if "${REAL_FLOCK}" -n 9; then lock=free; else lock=held; fi
  echo "$lock $*" >"$FLOCK_REPORT"
fi
exec "${REAL_FLOCK}" "$@"`,
  )

  const common = {
    ...spawnEnv(target),
    PATH: `${stubs}:${process.env.PATH}`,
    HORIZON_HEALTH_TIMEOUT_S: '5',
    HORIZON_HEALTH_POLL_S: '0.05',
  }
  const children = []
  t.after(() => {
    for (const { child } of children) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }
    // Unblock any fifo open still pending in the thread pool, so a broken
    // handshake fails the test instead of hanging the process.
    for (const fifo of [inBuild, flockReport]) {
      try {
        closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK))
      } catch {}
    }
    rmSync(base, { recursive: true, force: true })
  })

  const a = runDeploy(DEPLOY_HORIZON_SH, 'v-a', { ...common, HOLD_DIR: base })
  children.push(a)
  assert.equal((await readFile(inBuild, 'utf8')).trim(), 'in-build')

  const b = runDeploy(DEPLOY_HORIZON_SH, 'v-b', { ...common, FLOCK_REPORT: flockReport })
  children.push(b)
  // B found A's lock held, and waits with the 30-minute default.
  assert.equal((await readFile(flockReport, 'utf8')).trim(), 'held -w 1800 9')

  await writeFile(release, 'go\n')
  const [codeA, codeB] = await Promise.all([a.exited, b.exited])

  const log = readFileSync(join(state, 'self-deploy.log'), 'utf8')
  assert.equal(codeA, 0, log)
  assert.equal(codeB, 0, log)
  const okLines = log.split('\n').filter((line) => line.includes('DEPLOY OK'))
  assert.equal(okLines.length, 2, log)
  assert.match(okLines[0], /DEPLOY OK tag=refs\/tags\/v-a /)
  assert.match(okLines[1], /DEPLOY OK tag=refs\/tags\/v-b /)
  assert.doesNotMatch(log, /DEPLOY FAILED/)
  assert.match(readFileSync(join(state, 'last-good-tag'), 'utf8'), /^refs\/tags\/v-b:/)
})

test('every deploy the server starts waits up to 30 minutes for the lock by default', () => {
  assert.equal(DEPLOY_LOCK_TIMEOUT_S, '1800')
  const env = spawnEnv({ key: 'ui-service', repoDir: '/opt/x', stateKey: 'ui-service', service: 'fintekkers-ui', healthUrl: 'http://x/' })
  assert.equal(env.HORIZON_DEPLOY_LOCK_TIMEOUT_S, '1800')
  // Both scripts take their lock bound from that variable.
  for (const script of [DEPLOY_HORIZON_SH, DEPLOY_UI_SERVICE_SH]) {
    assert.match(readFileSync(script, 'utf8'), /flock -w "\$LOCK_TIMEOUT_S"/, script)
  }
})

// Contract deviation, pending an operator ruling: the contract asks both
// scripts to contain HORIZON_DEPLOY_LOCK_TIMEOUT_S:-1800, but HZ-258's
// deploy-dry-run.test.mjs pins infra/host/ to main. This pins the actual state,
// so a manual run's 5-min default is visible rather than silently assumed.
test('the scripts keep their own 5-minute default; only server-started deploys get 30 minutes', () => {
  for (const script of [DEPLOY_HORIZON_SH, DEPLOY_UI_SERVICE_SH]) {
    assert.match(readFileSync(script, 'utf8'), /LOCK_TIMEOUT_S="\$\{HORIZON_DEPLOY_LOCK_TIMEOUT_S:-300\}"/, script)
  }
})

test('an explicit HORIZON_DEPLOY_LOCK_TIMEOUT_S in the server env wins over the 30-minute default', () => {
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', "const c = await import('./src/config.js'); console.log(c.DEPLOY_LOCK_TIMEOUT_S, process.env.HORIZON_DEPLOY_LOCK_TIMEOUT_S)"],
    { cwd: join(REPO_ROOT, 'server'), env: { ...process.env, HORIZON_DEPLOY_LOCK_TIMEOUT_S: '42' }, encoding: 'utf8' },
  )
  assert.equal(out.trim(), '42 42')
})

