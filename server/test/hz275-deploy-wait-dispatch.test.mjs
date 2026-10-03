// HZ-275: the Deploy step's farm task carries where and how long to wait for
// the item's own release to go live (deploy_wait), and the step's execution
// budget grows by that wait so the server's watchdog can't fire mid-wait.
// The farm does the waiting (farm/step_agent.py wait_until_release_live), so it
// survives the horizon-server restart a Horizon self-deploy causes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-hz275-dispatch-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-hz275-dispatch-home-')) // deploy.js derives state dirs from it
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire here
delete process.env.FARM_STEP_TIMEOUT_MS
delete process.env.HORIZON_DEPLOY_WAIT_MS

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, DEPLOY_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const { DEPLOY_WAIT_MS, FARM_STEP_TIMEOUT_MS } = await import('../src/config.js')
const { deployWaitFor } = await import('../src/deployWait.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue) VALUES (?, ?, ?, ?, ?, ?)')

// GitHub answers the release calls; everything else (the farm) is captured.
function captureDispatches() {
  const dispatched = []
  globalThis.fetch = async (url, opts) => {
    const u = String(url)
    if (u.includes('api.github.com') && u.includes('/releases/tags/')) return { ok: false, status: 404 }
    if (u.includes('api.github.com') && u.endsWith('/releases') && opts?.method === 'POST') {
      const body = JSON.parse(opts.body)
      return { ok: true, json: async () => ({ tag_name: body.tag_name, html_url: `https://github.com/x/releases/${body.tag_name}` }) }
    }
    if (u.includes('api.github.com')) return { ok: true, status: 200, json: async () => ({}) }
    dispatched.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null })
    return { ok: true, json: async () => ({}) }
  }
  return dispatched
}

async function dispatchOf(dispatched, id) {
  for (let i = 0; i < 50 && !dispatched.some((d) => d.url.includes('/steps/run') && d.body?.item?.id === id); i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  const dispatch = dispatched.find((d) => d.url.includes('/steps/run') && d.body?.item?.id === id)
  assert.ok(dispatch, `no /steps/run dispatch captured for ${id}`)
  return dispatch.body
}

test('the default wait bound is 20 minutes, end to end on the server side', () => {
  assert.equal(DEPLOY_WAIT_MS, 1_200_000)
  assert.equal(deployWaitFor('FinTekkers/horizon').timeout_s, 1200)
  assert.equal(deployWaitFor('acme/no-target'), null)
})

test("the Deploy step's execution budget covers the wait on top of the usual budget", () => {
  assert.equal(orchestrator.executionBudgetFor(DEPLOY_STEP_INDEX), FARM_STEP_TIMEOUT_MS + DEPLOY_WAIT_MS)
  assert.equal(orchestrator.executionBudgetFor(DEPLOY_STEP_INDEX - 2), FARM_STEP_TIMEOUT_MS)
})

test('a Deploy dispatch for a repo with a deploy target carries deploy_wait', async () => {
  const dispatched = captureDispatches()
  insertItem.run('HZW-1', 'Deploy with a target', 'Medium', DEPLOY_STEP_INDEX, 'FinTekkers/horizon', 1)
  orchestrator.kick('HZW-1')

  const body = await dispatchOf(dispatched, 'HZW-1')
  assert.equal(body.step.index, DEPLOY_STEP_INDEX)
  assert.equal(body.item.release_tag, 'deploy-hzw-1')
  assert.deepEqual(body.deploy_wait, { state_dir: join(process.env.HOME, '.horizon', 'horizon'), timeout_s: 1200 })
  orchestrator.cancel('HZW-1')
})

test('a Deploy dispatch for a repo with no deploy target sends no deploy_wait', async () => {
  const dispatched = captureDispatches()
  insertItem.run('HZW-2', 'Deploy without a target', 'Medium', DEPLOY_STEP_INDEX, 'acme/demo', 2)
  orchestrator.kick('HZW-2')

  const body = await dispatchOf(dispatched, 'HZW-2')
  assert.equal(body.item.release_tag, 'deploy-hzw-2')
  assert.equal(Object.hasOwn(body, 'deploy_wait'), false)
  orchestrator.cancel('HZW-2')
})

test('a farm step other than Deploy sends no deploy_wait', async () => {
  const dispatched = captureDispatches()
  const stepIndex = STEPS.findIndex((s, i) => i < DEPLOY_STEP_INDEX && s.runsIn === 'farm' && i > 4)
  insertItem.run('HZW-3', 'Not a deploy', 'Medium', stepIndex, 'FinTekkers/horizon', 3)
  orchestrator.kick('HZW-3')

  const body = await dispatchOf(dispatched, 'HZW-3')
  assert.equal(body.step.index, stepIndex)
  assert.equal(Object.hasOwn(body, 'deploy_wait'), false)
  orchestrator.cancel('HZW-3')
})
