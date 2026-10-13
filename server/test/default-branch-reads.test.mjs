// HZ-425 metric line 1: the two remaining readers of a repo's default-branch
// head — spawn.js's deployed HEAD for a repo with no deploy target, and
// project validation's check_commands / drift sha — read the repo's cached
// default branch (`master` here), never `main`. Both go through their own
// test seams; any network call fails the test.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-default-branch-reads-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-default-branch-reads-home-'))
process.env.GITHUB_TOKEN = 'ghp_TEST_SENTINEL_hz425'
for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]

const realFetch = globalThis.fetch
globalThis.fetch = () => {
  throw new Error('test reached the network: stub this dependency')
}
after(() => {
  globalThis.fetch = realFetch
})

const store = await import('../src/store.js')
const spawn = await import('../src/spawn.js')
const pv = await import('../src/projectValidate.js')

const REPO = 'acme/price-service'
const HEAD = 'd'.repeat(40)
const project = store.createProject('HZ-425 reads')
assert.ok(store.addRepoToProject(project.id, REPO).ok)
assert.ok(store.setDefaultBranch(REPO, 'master'))

test('spawn: a repo with no deploy target reads its default branch head on master', async () => {
  const branches = []
  spawn.setSpawnGitForTest({
    resolveTarget: () => null,
    getBranchSha: async (repo, branch) => {
      branches.push(`${repo}@${branch}`)
      return HEAD
    },
  })
  try {
    assert.deepEqual(await spawn.spawnedCodeLive({ id: 'PS-1', repo: REPO }), { ready: true, sha: HEAD })
  } finally {
    spawn.setSpawnGitForTest(null)
  }
  assert.deepEqual(branches, [`${REPO}@master`])
})

test('project validation: check_commands and drift read the default branch head on master', async () => {
  const original = { ...pv.deps }
  const branches = []
  Object.assign(pv.deps, {
    getRepoPermissions: async () => ({ ok: true, status: 200, push: true }),
    inspectWebhook: async () => ({ status: 'ok', lastResponseCode: 200, reason: null }),
    getBranchSha: async (repo, branch) => {
      branches.push(`${repo}@${branch}`)
      return HEAD
    },
    spawn: async () => ({ code: 0, stdout: JSON.stringify({ ok: true, detail: 'checks passed' }), stderr: '', timedOut: false }),
    checkCommands: () => null,
    repoConfig: () => null,
    resolveRules: () => ['# rules'],
    findTargetByRepo: () => null,
    listTargets: () => [],
    targetState: () => null,
    runDryRun: async () => [],
    tryBeginDryRun: () => true,
    endDryRun: () => {},
    recordValidation: () => 1,
  })
  try {
    await pv.validateProject({ id: project.id, name: 'HZ-425 reads', repos: [{ repo: REPO }] })
  } finally {
    Object.assign(pv.deps, original)
  }
  assert.ok(branches.length > 0, 'validation read the branch head')
  assert.deepEqual([...new Set(branches)], [`${REPO}@master`])
})
