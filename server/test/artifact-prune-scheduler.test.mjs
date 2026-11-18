// HO-890 metric 1 and guardrail 4 (prune): the scheduled artifact prune goes
// through each registered backend's Artifact port —
// forKind(backend).artifacts.pruneArtifacts — once per tick, at boot and then
// every PRUNE_TICK_MS. server.js arms it once, and startPolling no longer
// prunes on its own. One backend's prune failing, thrown or rejected, never
// stops another's.
//
// The backends are fakes swapped in with setBackendForTest; the timer is
// node:test's mock.timers, never a sleep.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { stripComments } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-artifact-prune-scheduler-')), 'test.db')
for (const key of ['GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'FARM_HOME', 'HORIZON_REPO']) delete process.env[key]

const { BACKENDS, setBackendForTest } = await import('../src/backends/index.js')
const { githubAdapters } = await import('../src/backends/github.js')
const { slAdapters } = await import('../src/backends/sl.js')
const { PRUNE_TICK_MS, pruneTick, startArtifactPrune } = await import('../src/backends/artifactPrune.js')

const REAL = { github: githubAdapters, sl: slAdapters }

// Each backend's artifacts.pruneArtifacts replaced by `impl`, recording calls.
function fakePrunes(t, impls = {}) {
  const calls = Object.fromEntries(BACKENDS.map((b) => [b, []]))
  for (const backend of BACKENDS) {
    const impl = impls[backend] ?? (async () => ({ deleted: 0 }))
    const pruneArtifacts = (...args) => {
      calls[backend].push(args)
      return impl(...args)
    }
    setBackendForTest(backend, { ...REAL[backend], artifacts: Object.freeze({ ...REAL[backend].artifacts, pruneArtifacts }) })
  }
  t.after(() => {
    for (const backend of BACKENDS) setBackendForTest(backend, null)
  })
  return calls
}

const recordingLog = () => {
  const warns = []
  return { warns, log: { info() {}, warn: (m) => warns.push(m), error() {}, debug() {} } }
}

// The text of `name`'s body in `file` (server/src-relative), comments blanked.
function functionBody(file, name) {
  const source = stripComments(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'))
  const start = source.indexOf(`export function ${name}(`)
  assert.ok(start >= 0, `${file} defines ${name}`)
  const end = source.indexOf('\n}\n', start)
  assert.ok(end > start, `${name} has a closing brace`)
  return source.slice(start, end)
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

// ---- metric 1 ----

test('metric 1: one prune tick calls artifacts.pruneArtifacts exactly once on each registered backend; startPolling prunes nothing itself', async (t) => {
  assert.deepEqual([...BACKENDS], ['github', 'sl'])
  const calls = fakePrunes(t, { github: async () => ({ deleted: 2 }), sl: async () => null })
  const { log } = recordingLog()

  const result = await pruneTick(log)

  for (const backend of BACKENDS) {
    assert.equal(calls[backend].length, 1, `${backend} pruned once`)
    assert.equal(calls[backend][0][0].log, log, `${backend} got the tick's logger`)
  }
  assert.deepEqual(result, { github: { deleted: 2 }, sl: null })
  assert.deepEqual(Object.keys(result), [...BACKENDS], 'no backend is skipped')

  const startPolling = functionBody('github.js', 'startPolling')
  assert.doesNotMatch(startPolling, /pruneArtifactRefs/)
  assert.doesNotMatch(startPolling, /pruneArtifacts/)
  assert.doesNotMatch(startPolling, /\bprune\s*\(/)
  assert.doesNotMatch(startPolling, /ARTIFACTS_PRUNE_MS/)
})

test('metric 1: startArtifactPrune prunes every backend once at boot and again after PRUNE_TICK_MS; server.js arms it once', async (t) => {
  const calls = fakePrunes(t)
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { log } = recordingLog()

  const timer = startArtifactPrune(log)
  t.after(() => clearInterval(timer))
  await flush()
  for (const backend of BACKENDS) assert.equal(calls[backend].length, 1, `${backend} pruned at boot`)

  t.mock.timers.tick(PRUNE_TICK_MS - 1)
  await flush()
  for (const backend of BACKENDS) assert.equal(calls[backend].length, 1, `${backend} not pruned before the tick`)

  t.mock.timers.tick(1)
  await flush()
  for (const backend of BACKENDS) assert.equal(calls[backend].length, 2, `${backend} pruned again after PRUNE_TICK_MS`)

  const server = stripComments(readFileSync(new URL('../src/server.js', import.meta.url), 'utf8'))
  assert.equal(server.split('startArtifactPrune(fastify.log)').length - 1, 1, 'server.js calls startArtifactPrune(fastify.log) once')
  assert.match(server, /^import \{ startArtifactPrune \} from '\.\/backends\/artifactPrune\.js'$/m)
  assert.doesNotMatch(server, /pruneArtifacts\s*\(/, 'server.js schedules no backend prune of its own')
  assert.doesNotMatch(server, /pruneArtifactRefs/)
})

// ---- guardrail 4 (prune) ----

test('guardrail 4: GitHub prune throwing synchronously and sl prune rejecting are each logged; both run and the tick resolves', async (t) => {
  const calls = fakePrunes(t, {
    github: () => {
      throw new Error('gh-boom')
    },
    sl: async () => {
      throw new Error('sl-boom')
    },
  })
  const { log, warns } = recordingLog()

  const result = await pruneTick(log)

  assert.equal(calls.github.length, 1)
  assert.equal(calls.sl.length, 1)
  assert.deepEqual(result, { github: { error: 'gh-boom' }, sl: { error: 'sl-boom' } })
  assert.deepEqual(warns.sort(), ['artifacts prune failed: gh-boom', 'sl artifacts prune failed: sl-boom'])
})

test('guardrail 4: a failing GitHub prune does not stop the sl prune, whose result still comes back', async (t) => {
  const calls = fakePrunes(t, {
    github: async () => {
      throw new Error('gh-down')
    },
    sl: async () => ({ deleted: 1 }),
  })
  const { log, warns } = recordingLog()
  assert.deepEqual(await pruneTick(log), { github: { error: 'gh-down' }, sl: { deleted: 1 } })
  assert.deepEqual(warns, ['artifacts prune failed: gh-down'])
  assert.equal(calls.sl.length, 1)
})
