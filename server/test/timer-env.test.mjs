// HZ-925: the agent output page poll (runLogView.js POLL_MS) and the deploy
// queue tick (deployQueue.js TICK_MS) keep their production values unless
// RUN_LOG_POLL_MS / DEPLOY_TICK_MS is set (the e2e server sets 200). Each case
// imports the module in its own process, since the value is read once at import.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function run(vars, script) {
  const dir = mkdtempSync(join(tmpdir(), 'timer-env-'))
  try {
    return runIn(dir, vars, script)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function runIn(dir, vars, script) {
  const env = { ...process.env, HORIZON_DB: join(dir, 'h.db') }
  delete env.RUN_LOG_POLL_MS
  delete env.DEPLOY_TICK_MS
  delete env.FARM_HOME
  Object.assign(env, vars)
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `${script}; process.exit(0)`], {
    cwd: new URL('..', import.meta.url),
    env,
    encoding: 'utf8',
  })
  return JSON.parse(out.trim().split('\n').pop())
}

const poll = (vars) =>
  run(vars, "const m = await import('./src/runLogView.js'); console.log(JSON.stringify({ ms: m.POLL_MS, page: m.clientScript().match(/var POLL_MS = [^;]*;/)[0] }))")
const tick = (vars) =>
  run(vars, "const m = await import('./src/deployQueue.js'); console.log(JSON.stringify({ ms: m.TICK_MS, window: m.TICK_MS * m.DEFAULT_BRANCH_MAX_ATTEMPTS }))")

test('POLL_MS: unset is the production 2000 ms, and the page polls at it', () => {
  assert.deepEqual(poll({}), { ms: 2000, page: 'var POLL_MS = 2000;' })
})

test('POLL_MS: RUN_LOG_POLL_MS=200 shortens it, in the page too', () => {
  assert.deepEqual(poll({ RUN_LOG_POLL_MS: '200' }), { ms: 200, page: 'var POLL_MS = 200;' })
})

test('POLL_MS: junk keeps production, and 0 is held at the floor, never off', () => {
  assert.equal(poll({ RUN_LOG_POLL_MS: 'abc' }).ms, 2000)
  assert.deepEqual(poll({ RUN_LOG_POLL_MS: '0' }), { ms: 50, page: 'var POLL_MS = 50;' })
})

test('TICK_MS: unset is the production 5000 ms, a batch-failure window of 5 minutes', () => {
  assert.deepEqual(tick({}), { ms: 5000, window: 300000 })
})

test('TICK_MS: DEPLOY_TICK_MS=200 shortens it, and the window to 12 s', () => {
  assert.deepEqual(tick({ DEPLOY_TICK_MS: '200' }), { ms: 200, window: 12000 })
})

test('TICK_MS: junk keeps production, and 0 is held at the floor, never off', () => {
  assert.equal(tick({ DEPLOY_TICK_MS: 'abc' }).ms, 5000)
  assert.equal(tick({ DEPLOY_TICK_MS: '0' }).ms, 50)
})
