// HZ-728: a step reply's `asks` — drafted follow-up and prerequisite items —
// are validated and stored as `ask` rows linked to the item and the step run,
// and the item snapshot lists the open ones. A refused ask never fails the
// run: the artifact's `## Asks` section and an event name the field. A PM
// split is recorded as an ask of kind 'split'. Nothing is filed and no gate
// changes. Runs are driven through the real orchestrator.completeFarmRun with
// a captured farm and GitHub (helpers/splitGithubStub.mjs).

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitGithubStub } from './helpers/splitGithubStub.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-asks-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.GITHUB_TOKEN = 'ghp_TEST_ASKS'
delete process.env.GITHUB_WEBHOOK_SECRET

const stub = splitGithubStub()
globalThis.fetch = stub.fetch

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { composeIssueBody } = await import('../src/github.js')
const { requiredStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
await orchestrator.init({ info: () => {}, warn: () => {} })
await new Promise((r) => setTimeout(r, 50)) // ensureFarm's start handshake

after(() => {
  for (const { item_id } of db.prepare("SELECT DISTINCT item_id FROM step_run WHERE status = 'active'").all()) orchestrator.cancel(item_id)
})

const ARCH = requiredStepIndex('Architecture review')
const DIGEST = requiredStepIndex('Summarize reviews & recommend')
const REVIEW = requiredStepIndex('Automated review (code + QA)')
const ARCH_LABEL = 'Architecture review'
const SRC = 'FinTekkers/ledger-service'
const LIB = 'FinTekkers/ledger-models'
const OTHER = 'Acme/elsewhere'

const project = store.createProject('FinTekkers').id
for (const repo of [SRC, LIB]) store.addRepoToProject(project, repo)
store.addRepoToProject(store.createProject('Acme').id, OTHER)

const ARCH_MD = '## Verdict\n**pass-with-notes**\n## Notes\n- The publish script commits under the owner identity.'
const DIGEST_MD = '## Recommendation\n**PROCEED** — part 1 now.\n## Actions\nNone.'

const ask = (over = {}) => ({
  kind: 'blocking',
  title: 'Publish script must use the bot identity',
  repo: LIB,
  outcome: 'The publish script commits as the bot.\nOwners stop seeing their name on bot commits.',
  metric: '1. Commits name the bot.\n2. The owner identity is never used.\n3. A dry run prints the identity.\n4. The script exits non-zero without one.',
  guardrails: '1. No change to the release tag format.\n2. No new secrets.',
  why: `${ARCH_LABEL}: 'The publish script commits under the owner identity.'`,
  ...over,
})

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

function newItem(title, cursor) {
  const issue = stub.addIssue(SRC, { title, body: composeIssueBody({ outcome: 'Fix it.', metric: 'Works.', guardrails: '' }) })
  const id = `LS-${issue.number}`
  db.prepare(
    "INSERT INTO work_item (id, title, priority, desc, metric, guardrails, issue, repo, project_id, cursor) VALUES (?, ?, 'Medium', 'Fix it.', 'Works.', '', ?, ?, ?, ?)",
  ).run(id, title, issue.number, SRC, project, cursor)
  return id
}

// Completes one run of `step` for `id` with these artifacts; returns the run id.
async function runStep(id, step, artifacts) {
  orchestrator.kick(id)
  await tick()
  const run = db.prepare("SELECT id FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'active'").get(id, step)
  assert.ok(run, `no active run for ${id} at “${step}”`)
  assert.deepEqual(await orchestrator.completeFarmRun(run.id, { summary: 'done', artifacts }), { ok: true })
  return run.id
}

const asksOf = (id) => db.prepare('SELECT * FROM ask WHERE item_id = ? ORDER BY id').all(id)
const runOf = (runId) => db.prepare('SELECT * FROM step_run WHERE id = ?').get(runId)
const eventsOf = (id) => db.prepare("SELECT text FROM event WHERE item_id = ? AND who = 'Horizon'").all(id).map((e) => e.text)

test('a valid asks list stores one row per ask, linked to the item and step run, and the snapshot lists each', async () => {
  const id = newItem('two asks', ARCH)
  const soft = ask({ kind: 'soft', title: 'Document the publish identity', repo: SRC })
  const runId = await runStep(id, ARCH, { artifact_md: ARCH_MD, asks: [ask(), soft] })

  const rows = asksOf(id)
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(row.item_id, id)
    assert.equal(row.step_run_id, runId)
    assert.equal(row.step_index, ARCH)
    assert.equal(row.status, 'open')
  }
  // The multi-line outcome, guardrails and 4-line metric are kept as sent.
  assert.deepEqual(JSON.parse(rows[0].draft_json), {
    title: ask().title,
    repo: LIB,
    outcome: ask().outcome,
    metric: ask().metric,
    guardrails: ask().guardrails,
  })

  const view = store.itemViewById(id).asks
  assert.deepEqual(
    view.map((a) => [a.kind, a.title, a.repo, a.why, a.step]),
    [
      ['soft', soft.title, SRC, soft.why, ARCH_LABEL],
      ['blocking', ask().title, LIB, ask().why, ARCH_LABEL],
    ],
  )
  assert.equal(view[1].metric, ask().metric)
  assert.equal(view[1].outcome, ask().outcome)
  assert.equal(view[1].guardrails, ask().guardrails)
  assert.match(store.latestArtifact(id, ARCH), /## Asks\n- \*\*Stored:\*\* 1 blocking, 1 soft\./)
})

test('bad asks are not stored and the step run names each field; the artifact, the valid ask and the advance are kept', async () => {
  const plain = newItem('no asks', ARCH)
  await runStep(plain, ARCH, { artifact_md: ARCH_MD })
  const expectedCursor = store.getItem(plain).cursor
  assert.equal(asksOf(plain).length, 0)
  assert.equal(store.latestArtifact(plain, ARCH), ARCH_MD, 'a reply without asks adds no section')

  const id = newItem('mixed asks', ARCH)
  const { guardrails: _dropped, ...noGuardrails } = ask({ title: 'No guardrails' })
  const runId = await runStep(id, ARCH, {
    artifact_md: ARCH_MD,
    asks: [
      ask({ title: 'The valid one' }),
      noGuardrails,
      ask({ title: 'Seven lines', metric: '1.\n2.\n3.\n4.\n5.\n6.\n7.' }),
      ask({ title: 'Unconnected', repo: OTHER }),
    ],
  })

  assert.deepEqual(asksOf(id).map((r) => JSON.parse(r.draft_json).title), ['The valid one'])
  const run = runOf(runId)
  assert.equal(run.status, 'done')
  assert.equal(store.getItem(id).cursor, expectedCursor, 'the cursor advances as it does without asks')

  const artifact = run.artifact
  assert.ok(artifact.startsWith(ARCH_MD), 'the original artifact is kept')
  const section = artifact.slice(artifact.indexOf('## Asks'))
  assert.match(section, /\*\*Stored:\*\* 1 blocking\./)
  assert.match(section, /“No guardrails” from “Architecture review” — `guardrails` is missing/)
  assert.match(section, /“Seven lines” from “Architecture review” — `metric` has 7 lines; 3–5 required/)
  assert.match(section, /“Unconnected” from “Architecture review” — `repo` `Acme\/elsewhere` is not connected/)

  // Steps by name: the refusal lines, the events and the snapshot.
  const events = eventsOf(id).filter((t) => t.startsWith('did not store an ask'))
  assert.equal(events.length, 3)
  for (const text of [...section.split('\n').filter((l) => l.includes('Not stored')), ...events]) {
    assert.ok(text.includes(`“${ARCH_LABEL}”`), text)
    assert.doesNotMatch(text, /step \d+/i)
  }
  for (const field of ['guardrails', 'metric', 'repo']) assert.ok(events.some((t) => t.includes(`\`${field}\``)), field)
  const [shown] = store.itemViewById(id).asks
  assert.equal(shown.step, ARCH_LABEL)
  assert.doesNotMatch(shown.step, /step \d+/i)
})

test('metric line count: 3 and 5 non-blank lines are stored, 2 and 6 are refused, blank lines do not count', async () => {
  const id = newItem('metric bounds', ARCH)
  const runId = await runStep(id, ARCH, {
    artifact_md: ARCH_MD,
    asks: [
      ask({ title: 'two', metric: '1. a\n2. b' }),
      ask({ title: 'three', metric: '1. a\n2. b\n3. c' }),
      ask({ title: 'five', metric: '1. a\n2. b\n3. c\n4. d\n5. e' }),
      ask({ title: 'six', metric: '1. a\n2. b\n3. c\n4. d\n5. e\n6. f' }),
      ask({ title: 'three with blanks', metric: '1. a\n\n2. b\n   \n3. c\n' }),
      ask({ title: 'two with blanks', metric: '1. a\n\n\n2. b\n\n' }),
    ],
  })
  assert.deepEqual(asksOf(id).map((r) => JSON.parse(r.draft_json).title), ['three', 'five', 'three with blanks'])
  const artifact = runOf(runId).artifact
  assert.match(artifact, /“two” from .* `metric` has 2 lines/)
  assert.match(artifact, /“six” from .* `metric` has 6 lines/)
  assert.match(artifact, /“two with blanks” from .* `metric` has 2 lines/)
})

test('plan text only: a host path in outcome and a token in why are refused, naming the field', async () => {
  const id = newItem('plan text', ARCH)
  const runId = await runStep(id, ARCH, {
    artifact_md: ARCH_MD,
    asks: [
      ask({ title: 'Host path', outcome: 'Read the log at /home/ubuntu/.horizon-farm/logs/run.log first.' }),
      ask({ title: 'Token', why: `${ARCH_LABEL}: 'pushed with ghp_${'A'.repeat(36)}'` }),
      ask({ title: 'Kind split', kind: 'split' }),
      ask({ title: 'Kind urgent', kind: 'urgent' }),
      ask({ title: 'Read /home/ubuntu/notes.txt' }),
    ],
  })
  assert.equal(asksOf(id).length, 0)
  const artifact = runOf(runId).artifact
  assert.match(artifact, /“Host path” .* `outcome` holds a host path/)
  assert.match(artifact, /“Token” .* `why` holds a token or secret/)
  assert.match(artifact, /“Kind split” .* `kind` must be blocking or soft/)
  assert.match(artifact, /“Kind urgent” .* `kind` must be blocking or soft/)
  assert.doesNotMatch(artifact, /ghp_A{36}/, 'the token is not echoed back')
  assert.match(artifact, /“Read \[host path removed\]” .* `title` holds a host path/)
  assert.doesNotMatch(artifact, /\/home\//, 'a refused title is echoed without its host path')
})

test('ingest files nothing: no dependency, no Blockers section, no GitHub write', async () => {
  const id = newItem('files nothing', ARCH)
  // GitHub writes only: the farm dispatches go through the same stub.
  const githubWrites = () => stub.calls.filter((c) => c.method !== 'GET' && c.path.startsWith('/repos/'))
  const before = githubWrites().length
  const runId = await runStep(id, ARCH, { artifact_md: ARCH_MD, asks: [ask(), ask({ repo: OTHER })] })
  await tick()
  assert.equal(asksOf(id).length, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_item_dependency WHERE item_id = ? OR depends_on_id = ?').get(id, id).n, 0)
  assert.doesNotMatch(runOf(runId).artifact, /## Blockers/)
  assert.equal(stub.creates().length, 0)
  // The only GitHub write is the step comment every completed run posts.
  assert.deepEqual(githubWrites().slice(before).map((c) => `${c.method} ${c.path}`), [`POST /repos/${SRC}/issues/${store.getItem(id).issue}/comments`])
})

test('a re-run of the same step supersedes the earlier run’s open asks', async () => {
  const id = newItem('re-run', ARCH)
  const first = await runStep(id, ARCH, { artifact_md: ARCH_MD, asks: [ask({ title: 'first run' })] })
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(ARCH, id)
  orchestrator.cancel(id)
  const second = await runStep(id, ARCH, { artifact_md: ARCH_MD, asks: [ask({ title: 'second run' })] })
  assert.notEqual(first, second)
  assert.deepEqual(
    asksOf(id).map((r) => [JSON.parse(r.draft_json).title, r.status]),
    [
      ['first run', 'superseded'],
      ['second run', 'open'],
    ],
  )
  assert.deepEqual(store.itemViewById(id).asks.map((a) => a.title), ['second run'])
})

test('a PM split is recorded as a split ask beside a soft ask; a re-run supersedes both; a filed split writes none', async () => {
  const id = newItem('split', DIGEST)
  const split = {
    title: 'measuresForArm returns every arm',
    description: 'The deferred half of the item.',
    metric: '1. measuresForArm returns every arm.',
    guardrails: '1. No API change.',
  }
  const runId = await runStep(id, DIGEST, {
    artifact_md: DIGEST_MD,
    split,
    asks: [ask({ kind: 'soft', title: 'Tidy the digest', repo: SRC, why: `Summarize reviews & recommend: 'part 1 now'` })],
  })
  const splitRow = db.prepare("SELECT * FROM item_split WHERE source_item_id = ? AND status = 'proposed'").get(id)
  assert.ok(splitRow, 'the split is still proposed as before')
  const rows = asksOf(id)
  assert.deepEqual(rows.map((r) => [r.kind, r.status, r.step_run_id]), [
    ['split', 'open', runId],
    ['soft', 'open', runId],
  ])
  assert.equal(rows[0].item_split_id, splitRow.id)
  assert.deepEqual(JSON.parse(rows[0].draft_json), {
    title: split.title,
    repo: SRC,
    outcome: split.description,
    metric: split.metric,
    guardrails: split.guardrails,
  })
  assert.ok(rows[0].why.includes('“Summarize reviews & recommend”'))
  assert.deepEqual(store.itemViewById(id).asks.map((a) => a.kind).sort(), ['soft', 'split'])

  // A second run of the same step with neither supersedes both.
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(DIGEST, id)
  await runStep(id, DIGEST, { artifact_md: DIGEST_MD })
  assert.deepEqual(asksOf(id).map((r) => r.status), ['superseded', 'superseded'])
  assert.deepEqual(store.itemViewById(id).asks, [])

  // Already filed for this repo: nothing new will be filed, so no open split ask.
  const filedId = newItem('already filed', DIGEST)
  const target = newItem('the filed follow-up', 0)
  db.prepare(
    "INSERT INTO item_split (source_item_id, target_repo, status, payload_json, plan_run_id, target_issue, target_item_id) VALUES (?, ?, 'filed', '{}', 0, 9001, ?)",
  ).run(filedId, SRC, target)
  const artifact = runOf(await runStep(filedId, DIGEST, { artifact_md: DIGEST_MD, split })).artifact
  assert.match(artifact, /\*\*Already filed\*\*/)
  assert.equal(asksOf(filedId).length, 0)
})

test('the automated review stores asks from its reply too', async () => {
  const id = newItem('review asks', REVIEW)
  const QA_PASS = { verdict: 'pass', regression_tests_run: true, new_code_unit_coverage: true, e2e_test_present: true, findings: [] }
  await runStep(id, REVIEW, {
    artifact_md: '## Code review\n**pass**',
    verdict: { code_review: { verdict: 'pass', findings: [] }, qa_review: QA_PASS },
    asks: [ask({ title: 'From the review', why: `Automated review (code + QA): 'note on publish'` })],
  })
  const [row] = asksOf(id)
  assert.equal(row.step_index, REVIEW)
  assert.equal(JSON.parse(row.draft_json).title, 'From the review')
  assert.match(store.latestArtifact(id, REVIEW), /## Asks\n- \*\*Stored:\*\* 1 blocking\./)
})

test('additive schema: step_run and item_split keep exactly the columns they have on main', () => {
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
  // As on main when HZ-728 added the ask table; an item that adds a column
  // to either table on purpose updates this list.
  assert.deepEqual(columns('item_split'), [
    'id', 'source_item_id', 'target_repo', 'status', 'payload_json', 'plan_run_id', 'target_issue', 'target_item_id', 'error', 'created_at', 'updated_at',
  ])
  assert.deepEqual(columns('step_run'), [
    'id', 'item_id', 'step_index', 'attempt', 'agent', 'status', 'output', 'started_at', 'ended_at', 'artifact', 'agent_started_at',
    'auto_retry_count', 'provider', 'command_id', 'model', 'scope_json', 'deploy_interrupted', 'rule_blocked', 'job_view', 'substep_id',
    'checks_ms', 'checks_started_at', 'verdict', 'verdict_summary', 'usage_limit_hit', 'runs_on', 'fallback_from', 'fallback_reset_at',
    'source_shas', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd', 'agent_run',
    'test_runs_expected', 'test_runs_stored', 'test_runs_stored_at', 'test_runs_abandoned',
  ])
})
