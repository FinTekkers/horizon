// Deploy step deep-verification gate (HZ-22). The Deploy step's real side
// effect — publishing the GitHub release — still happens here in Node
// (dispatchToFarm), since only this process holds the GitHub token; the
// farm's DevOps agent only gets dispatched afterwards, to verify the
// already-published release. This mirrors review.test.mjs's structure:
// completeFarmRun is driven directly for the verdict-routing tests (no real
// farm/LLM needed), and a real kick() for the release-publish-before-
// dispatch behavior.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-gate-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, DEPLOY_STEP_INDEX } = await import('../src/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

const insertItem = db.prepare(
  'INSERT INTO work_item (id, title, priority, cursor, repo, issue) VALUES (?, ?, ?, ?, ?, ?)',
)

function activeRunFor(id, stepIndex, attempt = 1) {
  return db
    .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, ?, ?)')
    .run(id, stepIndex, attempt, STEPS[stepIndex].agent).lastInsertRowid
}

// ---- validateDeployVerdict ----

test('validateDeployVerdict accepts pass/fail and rejects malformed shapes', () => {
  assert.equal(orchestrator.validateDeployVerdict({ verdict: 'pass' }), true)
  assert.equal(orchestrator.validateDeployVerdict({ verdict: 'fail' }), true)
  assert.equal(orchestrator.validateDeployVerdict(null), false)
  assert.equal(orchestrator.validateDeployVerdict({}), false)
  assert.equal(orchestrator.validateDeployVerdict({ verdict: 'passed' }), false) // wrong enum value
})

// ---- completeFarmRun verdict routing ----

test('a passing deploy verdict advances past the Deploy step', async () => {
  insertItem.run('DEP-PASS', 'Passes deploy verification', 'Medium', DEPLOY_STEP_INDEX, null, null)
  const runId = activeRunFor('DEP-PASS', DEPLOY_STEP_INDEX)
  const result = await orchestrator.completeFarmRun(runId, {
    summary: 'verified — SMOKE_RESULT=pass',
    artifacts: { artifact_md: '# ok', verdict: { verdict: 'pass' } },
  })
  assert.deepEqual(result, { ok: true })
  const item = store.getItem('DEP-PASS')
  assert.equal(item.cursor, DEPLOY_STEP_INDEX + 1)
  assert.equal(item.paused, false)
})

test('a failing deploy verdict pauses the item without advancing, keeping the evidence', async () => {
  insertItem.run('DEP-FAIL', 'Fails deploy verification', 'Medium', DEPLOY_STEP_INDEX, null, null)
  const runId = activeRunFor('DEP-FAIL', DEPLOY_STEP_INDEX)
  const result = await orchestrator.completeFarmRun(runId, {
    summary: 'SMOKE_RESULT=fail: text never appeared',
    artifacts: { artifact_md: '# broken', verdict: { verdict: 'fail' } },
  })
  assert.deepEqual(result, { ok: true })
  const item = store.getItem('DEP-FAIL')
  assert.equal(item.cursor, DEPLOY_STEP_INDEX) // never advanced
  assert.equal(item.paused, true)
  const run = db.prepare('SELECT * FROM step_run WHERE id = ?').get(runId)
  assert.equal(run.status, 'done') // evidence kept, not discarded like a cancelled/infra-failed run
  assert.match(run.artifact, /broken/)
})

test('a malformed deploy verdict fails the run without pretending it deployed cleanly', async () => {
  insertItem.run('DEP-BAD', 'Malformed verdict', 'Medium', DEPLOY_STEP_INDEX, null, null)
  const runId = activeRunFor('DEP-BAD', DEPLOY_STEP_INDEX)
  const result = await orchestrator.completeFarmRun(runId, {
    summary: 'oops',
    artifacts: { artifact_md: '# oops', verdict: { verdict: 'maybe' } },
  })
  assert.deepEqual(result, { ok: true })
  const item = store.getItem('DEP-BAD')
  assert.equal(item.cursor, DEPLOY_STEP_INDEX) // never advanced
  assert.equal(item.paused, true)
})

// ---- dispatchToFarm: release publish happens here (Node), before the farm
// ever sees the step ----

test('dispatching the Deploy step publishes the release and sends it along to the farm', async () => {
  const dispatched = []
  globalThis.fetch = async (url, opts) => {
    const u = String(url)
    if (u.includes('api.github.com') && u.includes('/contents/')) {
      return { ok: true, json: async () => ({}) } // workflow file already present
    }
    if (u.includes('api.github.com') && u.includes('/releases/tags/')) {
      return { ok: false, status: 404 } // tag is free
    }
    if (u.includes('api.github.com') && u.endsWith('/releases') && opts?.method === 'POST') {
      return {
        ok: true,
        json: async () => ({ tag_name: 'deploy-dep-real', html_url: 'https://github.com/acme/demo/releases/tag/deploy-dep-real' }),
      }
    }
    dispatched.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null })
    return { ok: true, json: async () => ({}) }
  }

  insertItem.run('DEP-REAL', 'Real deploy dispatch', 'Medium', DEPLOY_STEP_INDEX, 'acme/demo', 7)
  orchestrator.kick('DEP-REAL')
  await new Promise((r) => setTimeout(r, 30)) // release publish + dispatch are both async

  const item = store.getItem('DEP-REAL')
  assert.equal(item.release_tag, 'deploy-dep-real')
  assert.equal(item.release_url, 'https://github.com/acme/demo/releases/tag/deploy-dep-real')

  const dispatch = dispatched.find((d) => d.url.includes('/steps/run') && d.body?.item?.id === 'DEP-REAL')
  assert.ok(dispatch, 'no /steps/run dispatch captured')
  assert.equal(dispatch.body.item.release_tag, 'deploy-dep-real')
  assert.equal(dispatch.body.item.release_url, 'https://github.com/acme/demo/releases/tag/deploy-dep-real')
  orchestrator.cancel('DEP-REAL')
})

test('a release-publish failure pauses the item and never hands the step to the farm', async () => {
  const dispatched = []
  globalThis.fetch = async (url, opts) => {
    const u = String(url)
    if (u.includes('api.github.com') && u.includes('/contents/')) {
      return { ok: true, json: async () => ({}) }
    }
    if (u.includes('api.github.com') && u.includes('/releases/tags/')) {
      return { ok: false, status: 404 }
    }
    if (u.includes('api.github.com') && u.endsWith('/releases') && opts?.method === 'POST') {
      return { ok: false, status: 403 } // token lacks Contents write, e.g.
    }
    dispatched.push({ url: u })
    return { ok: true, json: async () => ({}) }
  }

  insertItem.run('DEP-PUBFAIL', 'Release publish fails', 'Medium', DEPLOY_STEP_INDEX, 'acme/demo', 8)
  orchestrator.kick('DEP-PUBFAIL')
  await new Promise((r) => setTimeout(r, 30))

  const item = store.getItem('DEP-PUBFAIL')
  assert.equal(item.cursor, DEPLOY_STEP_INDEX) // never advanced
  assert.equal(item.paused, true)
  assert.equal(item.release_tag, null)
  assert.ok(!dispatched.some((d) => d.url.includes('/steps/run')))
})
