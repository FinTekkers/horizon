// HZ-275: publishing a release never commits a file to the product repo. The
// legacy ensureDeployWorkflow pushed a dummy .github/workflows/horizon-deploy.yml
// to FinTekkers/ui-service main, unreviewed, on that repo's first deploy. Only
// the two release calls remain; workflow files already in product repos are
// left where they are (a separate, human-approved cleanup).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-hz275-release-')), 'test.db')

const { db } = await import('../src/db.js')
const { createDeployRelease } = await import('../src/github.js')
const { MOCK_STEP_BEHAVIOR } = await import('../src/orchestrator.js')
// HZ-304: acme/demo's deploy target never passes re-validation; the row keeps
// the mock deploy publishing its release as before.
const { connectReadyRepo } = await import('./helpers/readyRepo.mjs')
connectReadyRepo(db, 'acme/demo', { unrunnableTarget: true })

// A mocked `gh`: every GitHub call goes through fetch. The tag is free, and
// the release is created.
function mockGitHub(t) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const path = new URL(String(url)).pathname
    const method = opts.method || 'GET'
    calls.push({ method, path })
    if (path.includes('/releases/tags/')) return { ok: false, status: 404, json: async () => ({}) }
    if (path.endsWith('/releases') && method === 'POST') {
      const body = JSON.parse(opts.body)
      return {
        ok: true,
        status: 201,
        json: async () => ({ tag_name: body.tag_name, html_url: `https://github.com/acme/demo/releases/tag/${body.tag_name}` }),
      }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
  return calls
}

test('createDeployRelease makes only the release calls, never a /contents/ call', async (t) => {
  const calls = mockGitHub(t)

  const release = await createDeployRelease({ repo: 'acme/demo', id: 'HZ-1', title: 'Ship it', issue: 1, pr: 2 })

  assert.equal(
    calls.filter((c) => c.path.startsWith('/repos/acme/demo/contents/')).length,
    0,
    `unexpected /contents/ calls: ${JSON.stringify(calls)}`,
  )
  assert.deepEqual(calls, [
    { method: 'GET', path: '/repos/acme/demo/releases/tags/deploy-hz-1' },
    { method: 'POST', path: '/repos/acme/demo/releases' },
  ])
  assert.equal(release.tag_name, 'deploy-hz-1')
  assert.equal(Object.hasOwn(release, 'addedWorkflow'), false)
})

test('the Deploy step summary no longer mentions adding a workflow', async (t) => {
  const calls = mockGitHub(t)

  const result = await MOCK_STEP_BEHAVIOR['Deploy the changes']({ repo: 'acme/demo', id: 'HZ-2', title: 'Ship', issue: 3 })

  assert.equal(result.summary, 'published release deploy-hz-2 — the self-deploy webhook will pull it to shoreward.ai')
  assert.doesNotMatch(result.summary, /workflow/i)
  assert.deepEqual(result.patch, { release_tag: 'deploy-hz-2', release_url: 'https://github.com/acme/demo/releases/tag/deploy-hz-2' })
  assert.equal(calls.some((c) => c.path.includes('/contents/')), false)
})
