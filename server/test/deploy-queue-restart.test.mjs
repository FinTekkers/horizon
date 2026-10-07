// HZ-333 guardrails 4, 5, 10: queue and batch state live in the database. A
// restart mid-window, mid-publish, mid-deploy or mid-verify resumes from the
// rows alone (each "boot" is a fresh process on the same DB file), loses no
// queued item and never publishes a second release for a batch. Booting the
// schema again leaves existing rows as they were.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useDeployTargetRows } from './helpers/deployTargetRows.mjs'
import { shaOf } from './helpers/deployQueueStub.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-queue-restart-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-deploy-queue-restart-home-'))
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000'
delete process.env.HORIZON_DEPLOY_BATCH_S
delete process.env.HORIZON_DEPLOY_WAIT_MS

const TARGETS = ['s1', 's2', 's3', 's4', 's5']
await useDeployTargetRows(TARGETS.map((key) => ({ key, repo: `acme/${key}`, stateKey: key, script: `${key}.sh`, service: `${key}-svc` })))

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { DEPLOY_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const { sqlTime, batchTag } = await import('../src/deployQueue.js')

store.purgeDemoItems()

const MAIN = shaOf(0xa0)
const NOW = Math.floor(Date.now() / 1000) * 1000
const prs = []

function boot({ releases = [] } = {}) {
  const out = execFileSync(process.execPath, [join(import.meta.dirname, 'helpers/deployQueueRestartChild.mjs')], {
    env: { ...process.env, NOW: String(NOW), STUB: JSON.stringify({ mainSha: MAIN, releases, prs }) },
    encoding: 'utf8',
  })
  return JSON.parse(out.trim().split('\n').at(-1))
}

// A target's batch in `status` with two queued items, as a crash left it.
function crashedBatch(target, status, { closesAt = NOW - 1000, startedAt = NOW - 60_000 } = {}) {
  const tag = status === 'open' ? null : batchTag(target, 900 + TARGETS.indexOf(target), startedAt)
  const batchId = db
    .prepare('INSERT INTO deploy_batch (target, repo, status, window_closes_at, tag, commit_sha, started_at, live_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(target, `acme/${target}`, status, sqlTime(closesAt), tag, tag ? MAIN : null, tag ? sqlTime(startedAt) : null, status === 'verifying' ? sqlTime(NOW - 10_000) : null)
    .lastInsertRowid
  const items = [1, 2].map((i) => {
    const id = `${target.toUpperCase()}-${i}`
    const pr = TARGETS.indexOf(target) * 10 + i
    db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr, release_tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      id,
      'Medium',
      DEPLOY_STEP_INDEX,
      `acme/${target}`,
      pr,
      pr,
      status === 'verifying' ? tag : null,
    )
    db.prepare('INSERT INTO deploy_queue_entry (item_id, target, merge_sha, batch_id, status, joined_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      target,
      shaOf(pr),
      batchId,
      status === 'verifying' ? 'released' : 'queued',
      sqlTime(NOW - 900_000),
    )
    prs.push([`acme/${target}#${pr}`, shaOf(pr)])
    return id
  })
  return { batchId, tag, items }
}

const batchIn = (out, id) => out.batches.find((b) => b.id === id)
const entriesIn = (out, batchId) => out.entries.filter((e) => e.batch_id === batchId)

test('mid-window: the window keeps its close time and nothing publishes', () => {
  const { batchId } = crashedBatch('s1', 'open', { closesAt: NOW + 300_000 })
  const out = boot()
  assert.equal(batchIn(out, batchId).status, 'open')
  assert.equal(batchIn(out, batchId).window_closes_at, sqlTime(NOW + 300_000))
  assert.deepEqual(entriesIn(out, batchId).map((e) => e.status), ['queued', 'queued'])
  assert.equal(out.posts.filter((p) => p.repo === 'acme/s1').length, 0)
})

test('window closed while down, then a restart mid-deploy: one release in total and no item lost', () => {
  const { batchId } = crashedBatch('s2', 'open')
  const first = boot()
  const published = first.posts.filter((p) => p.repo === 'acme/s2')
  assert.equal(published.length, 1)
  assert.equal(batchIn(first, batchId).status, 'deploying')
  assert.equal(published[0].tag_name, batchIn(first, batchId).tag)

  const second = boot({ releases: first.releases })
  assert.equal(second.posts.filter((p) => p.repo === 'acme/s2').length, 0)
  assert.equal(batchIn(second, batchId).status, 'deploying')
  assert.deepEqual(entriesIn(second, batchId).map((e) => e.status), ['queued', 'queued'])
})

test('tag saved, crashed before the POST: exactly one POST, with the saved tag; a release already there: none', () => {
  const { batchId, tag } = crashedBatch('s3', 'publishing')
  const first = boot()
  assert.deepEqual(first.posts.filter((p) => p.repo === 'acme/s3').map((p) => p.tag_name), [tag])
  assert.equal(first.posts.find((p) => p.tag_name === tag).target_commitish, MAIN)
  assert.equal(batchIn(first, batchId).status, 'deploying')

  const { batchId: b4, tag: t4 } = crashedBatch('s4', 'publishing')
  const existing = { repo: 'acme/s4', tag_name: t4, target_commitish: MAIN, html_url: 'https://x/s4' }
  const second = boot({ releases: [existing] })
  assert.equal(second.posts.filter((p) => p.repo === 'acme/s4').length, 0)
  assert.equal(batchIn(second, b4).status, 'deploying')
  assert.equal(batchIn(second, b4).release_url, 'https://x/s4')
})

test('mid-deploy, live while down: released on boot; mid-verify with every item past step 14: done', () => {
  const { batchId, tag, items } = crashedBatch('s5', 'deploying')
  mkdirSync(join(process.env.HOME, '.horizon', 's5'), { recursive: true })
  writeFileSync(join(process.env.HOME, '.horizon', 's5', 'last-good-tag'), `refs/tags/${tag}:${MAIN}\n`)
  const first = boot()
  assert.equal(batchIn(first, batchId).status, 'verifying')
  assert.deepEqual(entriesIn(first, batchId).map((e) => e.status), ['released', 'released'])
  assert.deepEqual(first.dispatched.sort(), items)
  assert.equal(first.posts.length, 0)

  // Restart mid-verify: still verifying while its smoke checks run …
  const again = boot()
  assert.equal(batchIn(again, batchId).status, 'verifying')
  // … and done once both items passed step 14.
  db.prepare('UPDATE work_item SET cursor = cursor + 1 WHERE id IN (?, ?)').run(...items)
  const last = boot()
  assert.equal(batchIn(last, batchId).status, 'done')
  assert.deepEqual(entriesIn(last, batchId).map((e) => e.status), ['passed', 'passed'])
})

test('guardrail 10: booting the schema again leaves existing items, runs and their release history unchanged', () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, release_tag, release_url) VALUES ('OLD-1', 'Old', 'Low', 15, 'deploy-old-1', 'https://x/old')").run()
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, output) VALUES ('OLD-1', ?, 1, 'DevOps', 'done', 'shipped')").run(DEPLOY_STEP_INDEX)
  const before = [db.prepare("SELECT * FROM work_item WHERE id = 'OLD-1'").get(), db.prepare("SELECT * FROM step_run WHERE item_id = 'OLD-1'").all()]
  boot()
  boot()
  const after = [db.prepare("SELECT * FROM work_item WHERE id = 'OLD-1'").get(), db.prepare("SELECT * FROM step_run WHERE item_id = 'OLD-1'").all()]
  assert.deepEqual(after, before)
})
