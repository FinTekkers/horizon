// HO-873 guardrail 2: server.js no longer imports github.js, and its boot
// wiring still reaches GitHub exactly as before, through the registry. The
// poll loop (which also arms the daily artifacts prune) starts once, handed
// the boot logger; the caretaker's mergeability re-read is GitHub's own
// refreshPrMergeable and forwards (itemId, repo, prNumber) unchanged.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { stripComments } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-server-boot-registry-')), 'test.db')
for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO']) delete process.env[key]

const github = await import('../src/github.js')
const { forKind, setBackendForTest } = await import('../src/backends/index.js')
const { githubAdapters } = await import('../src/backends/github.js')

const source = stripComments(readFileSync(new URL('../src/server.js', import.meta.url), 'utf8'))

test('server.js imports the registry and not github.js', () => {
  assert.doesNotMatch(source, /from\s*['"]\.\/github\.js['"]/)
  assert.match(source, /^import \{ forKind \} from '\.\/backends\/index\.js'$/m)
})

test('server.js starts polling through forKind(github) exactly once, and hands the caretaker review.refreshPrMergeable', () => {
  assert.equal(source.split('startPolling(').length - 1, 1, 'one startPolling( call')
  assert.match(source, /^forKind\('github'\)\.tracker\.startPolling\(fastify\.log\)$/m)
  assert.equal(source.split('refreshPrMergeable').length - 1, 1, 'one refreshPrMergeable reference')
  assert.match(source, /refreshMergeable: forKind\('github'\)\.review\.refreshPrMergeable \}/)
})

test('the registry hands server.js GitHub’s own startPolling and refreshPrMergeable', () => {
  assert.equal(forKind('github').tracker.startPolling, github.startPolling)
  assert.equal(forKind('github').review.refreshPrMergeable, github.refreshPrMergeable)
})

test('with stubs at the registry: startPolling(log) runs once with the logger, refreshPrMergeable forwards (itemId, repo, prNumber)', async () => {
  const calls = []
  const record = (name) => (...args) => {
    calls.push({ name, args })
    return Promise.resolve(null)
  }
  setBackendForTest('github', {
    ...githubAdapters,
    tracker: { ...githubAdapters.tracker, startPolling: record('startPolling') },
    review: { ...githubAdapters.review, refreshPrMergeable: record('refreshPrMergeable') },
  })
  try {
    // The two expressions server.js evaluates, as written there.
    const log = { info() {}, warn() {} }
    forKind('github').tracker.startPolling(log)
    const refreshMergeable = forKind('github').review.refreshPrMergeable
    await refreshMergeable('HZ-9', 'acme/boot', 42)
    assert.deepEqual(calls.map((c) => c.name), ['startPolling', 'refreshPrMergeable'])
    assert.equal(calls[0].args.length, 1)
    assert.equal(calls[0].args[0], log)
    assert.deepEqual(calls[1].args, ['HZ-9', 'acme/boot', 42])
  } finally {
    setBackendForTest('github', null)
  }
  assert.equal(forKind('github'), githubAdapters, 'the real adapters are back')
})
