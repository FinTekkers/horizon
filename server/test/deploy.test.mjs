// Self-deploy guardrail (HZ-19): isDeployableRelease must never trigger a
// deploy for a release published on the wrong repo, and runDeploy must never
// shell out directly in a test — it goes through the swappable `runner`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-')), 'test.db')

const { setSetting } = await import('../src/settings.js')
const deploy = await import('../src/deploy.js')

const publishedRelease = (over = {}) => ({
  action: 'published',
  repository: { full_name: 'FinTekkers/horizon' },
  release: { tag_name: 'v1', draft: false, prerelease: false, ...over },
})

test('accepts a published, non-draft, non-prerelease release on the connected repo', () => {
  setSetting('github_repo', 'FinTekkers/horizon')
  assert.equal(deploy.isDeployableRelease('FinTekkers/horizon', publishedRelease()), true)
})

test('rejects a release published on a different repo (the required guardrail)', () => {
  setSetting('github_repo', 'FinTekkers/horizon')
  assert.equal(deploy.isDeployableRelease('FinTekkers/shoreward', publishedRelease()), false)
})

test('rejects when no repo is configured — fails closed, not open', () => {
  setSetting('github_repo', '')
  assert.equal(deploy.isDeployableRelease('FinTekkers/horizon', publishedRelease()), false)
})

test('rejects actions other than "published"', () => {
  setSetting('github_repo', 'FinTekkers/horizon')
  for (const action of ['created', 'edited', 'unpublished', 'deleted']) {
    const body = { ...publishedRelease(), action }
    assert.equal(deploy.isDeployableRelease('FinTekkers/horizon', body), false, `action=${action} should be rejected`)
  }
})

test('rejects draft releases', () => {
  setSetting('github_repo', 'FinTekkers/horizon')
  assert.equal(deploy.isDeployableRelease('FinTekkers/horizon', publishedRelease({ draft: true })), false)
})

test('rejects prerelease releases', () => {
  setSetting('github_repo', 'FinTekkers/horizon')
  assert.equal(deploy.isDeployableRelease('FinTekkers/horizon', publishedRelease({ prerelease: true })), false)
})

test('rejects a malformed event with no release payload, without throwing', () => {
  setSetting('github_repo', 'FinTekkers/horizon')
  assert.equal(deploy.isDeployableRelease('FinTekkers/horizon', { action: 'published' }), false)
  assert.equal(deploy.isDeployableRelease('FinTekkers/horizon', {}), false)
})

test('rejects a missing repository full_name, without throwing', () => {
  setSetting('github_repo', 'FinTekkers/horizon')
  assert.equal(deploy.isDeployableRelease(undefined, publishedRelease()), false)
  assert.equal(deploy.isDeployableRelease(null, publishedRelease()), false)
})

test('runDeploy calls runner.spawn with the release tag and never shells out itself', () => {
  const calls = []
  const originalSpawn = deploy.runner.spawn
  deploy.runner.spawn = (tag) => calls.push(tag)
  try {
    deploy.runDeploy('v2', { info: () => {} })
    assert.deepEqual(calls, ['v2'])
  } finally {
    deploy.runner.spawn = originalSpawn
  }
})
