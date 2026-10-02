// Self-deploy guardrail (HZ-19, extended for HZ-41's deploy-target registry,
// the deploy_target table since HZ-263): isDeployableRelease must never
// trigger a deploy for a release published on a repo absent from the
// registry, runDeploy must never shell
// out directly in a test — it goes through the swappable `runner` — and two
// targets' on-disk state must never cross-contaminate.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useDeployTargetRows } from './helpers/deployTargetRows.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-')), 'test.db')

const fixtureHome = mkdtempSync(join(tmpdir(), 'horizon-deploy-home-'))
process.env.HOME = fixtureHome // deploy.js derives every state dir from os.homedir()

const FIXTURE_TARGETS = [
  {
    key: 'horizon',
    repo: 'FinTekkers/horizon',
    script: 'stub-horizon.sh',
    service: 'horizon-server-test',
    repoDir: '/tmp/fixture-horizon',
    stateKey: 'horizon',
    healthUrl: 'http://stub.invalid/horizon',
    healthCheckType: 'json-items',
  },
  {
    key: 'ui-service',
    repo: 'FinTekkers/ui-service',
    script: 'stub-ui.sh',
    service: 'fintekkers-ui-test',
    repoDir: '/tmp/fixture-ui-service',
    stateKey: 'ui-service',
    healthUrl: 'http://stub.invalid/ui-service',
    healthCheckType: 'ssr-asset-check',
  },
]
await useDeployTargetRows(FIXTURE_TARGETS)

const deploy = await import('../src/deploy.js')
const { db } = await import('../src/db.js')

const publishedRelease = (over = {}) => ({
  action: 'published',
  release: { tag_name: 'v1', draft: false, prerelease: false, ...over },
})

test('resolveTarget finds a registered repo', () => {
  assert.equal(deploy.resolveTarget('FinTekkers/horizon')?.key, 'horizon')
  assert.equal(deploy.resolveTarget('FinTekkers/ui-service')?.key, 'ui-service')
})

test('resolveTarget returns null for an unregistered repo, and for no repo at all', () => {
  assert.equal(deploy.resolveTarget('FinTekkers/some-other-repo'), null)
  assert.equal(deploy.resolveTarget(undefined), null)
  assert.equal(deploy.resolveTarget(null), null)
})

test('accepts a published, non-draft, non-prerelease release on a registered repo (registry hit)', () => {
  assert.equal(deploy.isDeployableRelease('FinTekkers/horizon', publishedRelease()), true)
})

test('accepts a published release on the second registered repo too (registry hit, second target)', () => {
  assert.equal(deploy.isDeployableRelease('FinTekkers/ui-service', publishedRelease()), true)
})

test('rejects a release published on a repo absent from the registry (registry miss, the required guardrail)', () => {
  assert.equal(deploy.isDeployableRelease('FinTekkers/some-other-repo', publishedRelease()), false)
})

test('rejects actions other than "published"', () => {
  for (const action of ['created', 'edited', 'unpublished', 'deleted']) {
    const body = { ...publishedRelease(), action }
    assert.equal(deploy.isDeployableRelease('FinTekkers/horizon', body), false, `action=${action} should be rejected`)
  }
})

test('rejects draft releases', () => {
  assert.equal(deploy.isDeployableRelease('FinTekkers/horizon', publishedRelease({ draft: true })), false)
})

test('rejects prerelease releases', () => {
  assert.equal(deploy.isDeployableRelease('FinTekkers/horizon', publishedRelease({ prerelease: true })), false)
})

test('rejects a malformed event with no release payload, without throwing', () => {
  assert.equal(deploy.isDeployableRelease('FinTekkers/horizon', { action: 'published' }), false)
  assert.equal(deploy.isDeployableRelease('FinTekkers/horizon', {}), false)
})

test('rejects a missing repository full_name, without throwing', () => {
  assert.equal(deploy.isDeployableRelease(undefined, publishedRelease()), false)
  assert.equal(deploy.isDeployableRelease(null, publishedRelease()), false)
})

test('runDeploy resolves the target and calls runner.spawn with (target, tag), never shelling out itself', () => {
  const calls = []
  const originalSpawn = deploy.runner.spawn
  deploy.runner.spawn = (target, tag) => calls.push({ target, tag })
  try {
    deploy.runDeploy('FinTekkers/horizon', 'v2', { info: () => {} })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].target.key, 'horizon')
    assert.equal(calls[0].tag, 'v2')
  } finally {
    deploy.runner.spawn = originalSpawn
  }
})

test('runDeploy on the second target resolves the second target, not the first', () => {
  const calls = []
  const originalSpawn = deploy.runner.spawn
  deploy.runner.spawn = (target, tag) => calls.push({ target, tag })
  try {
    deploy.runDeploy('FinTekkers/ui-service', 'v9', { info: () => {} })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].target.key, 'ui-service')
    assert.equal(calls[0].target.script, 'stub-ui.sh')
  } finally {
    deploy.runner.spawn = originalSpawn
  }
})

test('runDeploy on an unregistered repo is a no-op (defensive; isDeployableRelease already gates this)', () => {
  const calls = []
  const originalSpawn = deploy.runner.spawn
  deploy.runner.spawn = (target, tag) => calls.push({ target, tag })
  try {
    deploy.runDeploy('FinTekkers/some-other-repo', 'v-evil', { info: () => {} })
    assert.deepEqual(calls, [])
  } finally {
    deploy.runner.spawn = originalSpawn
  }
})

test('two targets have distinct stateKeys, so their on-disk state can never share a directory', () => {
  const horizon = deploy.resolveTarget('FinTekkers/horizon')
  const uiService = deploy.resolveTarget('FinTekkers/ui-service')
  assert.notEqual(horizon.stateKey, uiService.stateKey)
})

test('listTargetStatuses reports "never" for targets that have never deployed', () => {
  const statuses = deploy.listTargetStatuses()
  assert.equal(statuses.length, 2)
  for (const status of statuses) {
    assert.equal(status.lastResult, 'never')
    assert.equal(status.lastTag, null)
    assert.equal(status.lastAt, null)
  }
})

test('listTargetStatuses reads one target\'s on-disk state without leaking into the other (state isolation)', () => {
  const horizonStateDir = join(fixtureHome, '.horizon', 'horizon')
  mkdirSync(horizonStateDir, { recursive: true })
  writeFileSync(join(horizonStateDir, 'self-deploy.log'), '2026-09-14T03:22:10Z DEPLOY OK tag=refs/tags/v42 commit=abc1234\n')
  writeFileSync(join(horizonStateDir, 'last-good-tag'), 'refs/tags/v42:abc1234\n')

  const statuses = deploy.listTargetStatuses()
  const horizon = statuses.find((s) => s.key === 'horizon')
  const uiService = statuses.find((s) => s.key === 'ui-service')

  assert.equal(horizon.lastResult, 'ok')
  assert.equal(horizon.lastTag, 'refs/tags/v42')
  assert.equal(horizon.lastCommit, 'abc1234')
  assert.equal(horizon.lastAt, '2026-09-14T03:22:10Z')

  assert.equal(uiService.lastResult, 'never')
  assert.equal(uiService.lastTag, null)

  rmSync(horizonStateDir, { recursive: true, force: true })
})

test('listTargetStatuses reports a failed deploy without a last-good-tag', () => {
  const uiStateDir = join(fixtureHome, '.horizon', 'ui-service')
  mkdirSync(uiStateDir, { recursive: true })
  writeFileSync(uiStateDir + '/self-deploy.log', '2026-09-14T04:00:00Z DEPLOY FAILED: health-check (tag=refs/tags/v5 commit=def5678)\n')

  const statuses = deploy.listTargetStatuses()
  const uiService = statuses.find((s) => s.key === 'ui-service')
  assert.equal(uiService.lastResult, 'failed')
  assert.equal(uiService.lastTag, null)

  rmSync(uiStateDir, { recursive: true, force: true })
})

test('an empty deploy_target table fails closed: no throw, no targets resolve', async () => {
  db.prepare('DELETE FROM deploy_target').run() // table briefly empty, as if the seed had failed
  try {
    assert.equal(deploy.resolveTarget('FinTekkers/horizon'), null)
    assert.equal(deploy.isDeployableRelease('FinTekkers/horizon', publishedRelease()), false)
    assert.deepEqual(deploy.listTargetStatuses(), [])
  } finally {
    await useDeployTargetRows(FIXTURE_TARGETS)
  }
})

test('a deploy_target row failing validation fails closed: no throw, no targets resolve', async () => {
  db.prepare('DELETE FROM deploy_target').run()
  db.prepare(`INSERT INTO deploy_target (key, repo, script, service, repo_dir, state_key, health_url, health_check_type)
    VALUES ('horizon', 'FinTekkers/horizon', '../escape.sh', 'horizon-server-test', '/tmp/x', 'horizon', 'http://stub.invalid/', 'json-items')`).run()
  try {
    assert.equal(deploy.resolveTarget('FinTekkers/horizon'), null)
    assert.equal(deploy.isDeployableRelease('FinTekkers/horizon', publishedRelease()), false)
    // listTargetStatuses lists rows for display without deploying them, so the
    // invalid row is cleared before the status check (as in the empty-table case)
    db.prepare('DELETE FROM deploy_target').run()
    assert.deepEqual(deploy.listTargetStatuses(), [])
  } finally {
    await useDeployTargetRows(FIXTURE_TARGETS)
  }
})
