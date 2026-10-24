// HZ-550: a run's model, provider, tokens and cost land on its step_run row.
// The farm's report (farm/tests/fixtures/usage_stub.json, the same JSON
// farm/tests/test_usage_capture.py asserts the farm posts) is posted to the
// real completion route and read back from the row. Runs with no agent store 0,
// labelled non-agent; rows from before this change, and farms too old to
// report, stay NULL — never 0. Capture never fails a run, and the figures
// leave the server only through GET /api/admin/productivity.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { REPO_ROOT } from './helpers/repoFiles.mjs'
import { loginFixtureUser } from './helpers/session.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'horizon-step-run-usage-'))
process.env.HORIZON_DB = join(scratch, 'test.db')
process.env.HOME = join(scratch, 'home')
process.env.FARM_URL = 'http://farm.test'
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { NON_AGENT, cleanUsage, recordRunUsage } = await import('../src/stepUsage.js')
const { STEPS, DEPLOY_STEP_INDEX, EXECUTE_STEP_INDEX, FILE_ITEMS_STEP_INDEX, kindStepIndex } = await import('../../domain/js/lifecycle.js')
const { OPTIONS_STEP_INDEX } = await import('../src/split.js')

const STUB = JSON.parse(readFileSync(path.join(REPO_ROOT, 'farm/tests/fixtures/usage_stub.json'), 'utf8'))
const COLUMNS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd']
const USAGE_SQL = `SELECT status, provider, model, agent_run, ${COLUMNS.join(', ')} FROM step_run WHERE id = ?`

store.purgeDemoItems()
const projectId = db.prepare("INSERT INTO project (name) VALUES ('Usage project')").run().lastInsertRowid

// The app logs at trace level into `logs`, so a figure in any log line fails.
const logs = []
const app = buildApp({ logger: { level: 'trace', stream: { write: (line) => logs.push(line) } } })
await app.ready()
after(() => app.close())
const admin = loginFixtureUser(auth, config, { email: config.ADMIN_EMAIL, name: 'Admin' })

let seq = 0
function itemAt(stepIndex, kind = STEPS[stepIndex].itemKind ?? 'change') {
  const id = `USG-${++seq}`
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, kind, project_id) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    `Usage ${seq}`,
    'Medium',
    stepIndex,
    kind,
    projectId,
  )
  return id
}

function activeRun(id, stepIndex) {
  return db
    .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, ?, ?)')
    .run(id, stepIndex, 1, STEPS[stepIndex].agent ?? 'Horizon').lastInsertRowid
}

const complete = (runId, body) =>
  app.inject({
    method: 'POST',
    url: `/api/farm/steps/${runId}/complete`,
    headers: { 'x-farm-secret': config.FARM_SHARED_SECRET },
    payload: body,
  })

const stubArtifacts = (extra = {}) => ({ artifact_md: '## Done', provider: STUB.provider, model: STUB.model, usage: STUB.usage, ...extra })
const row = (runId) => db.prepare(USAGE_SQL).get(runId)

// ---- metric 1 ----

test('a completed agent run stores the stub’s model, provider and all five figures', async () => {
  const id = itemAt(OPTIONS_STEP_INDEX)
  const runId = activeRun(id, OPTIONS_STEP_INDEX)
  const consoleLines = []
  const saved = { log: console.log, warn: console.warn, error: console.error }
  for (const name of Object.keys(saved)) console[name] = (...args) => consoleLines.push(args.join(' '))
  let res
  try {
    res = await complete(runId, { summary: 'proposed three options', artifacts: stubArtifacts() })
  } finally {
    Object.assign(console, saved)
  }
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(row(runId), {
    status: 'done',
    provider: STUB.provider,
    model: STUB.model,
    agent_run: 1,
    input_tokens: STUB.usage.input_tokens,
    output_tokens: STUB.usage.output_tokens,
    cache_read_tokens: STUB.usage.cache_read_tokens,
    cache_write_tokens: STUB.usage.cache_write_tokens,
    cost_usd: STUB.usage.cost_usd,
  })
  // Guardrail 1: no log line — the app's or the console's — carries a figure.
  const logged = [...logs, ...consoleLines].join('\n')
  for (const key of COLUMNS) assert.ok(!logged.includes(String(STUB.usage[key])), `${key} was logged`)
  // Guardrail 1: the prompt never reached the server, so no row holds it.
  const stored = JSON.stringify(db.prepare('SELECT * FROM step_run WHERE id = ?').get(runId))
  assert.ok(!stored.includes(STUB.prompt_marker))
})

test('an agent Deploy, a Task step and a Plan step each store a non-null model and provider', async () => {
  const cases = [
    { index: DEPLOY_STEP_INDEX, artifacts: stubArtifacts({ verdict: { verdict: 'pass' } }) },
    { index: kindStepIndex('Impact review', 'task'), artifacts: stubArtifacts() },
    { index: kindStepIndex('Design options & recommendation', 'plan'), artifacts: stubArtifacts() },
  ]
  for (const { index, artifacts } of cases) {
    const runId = activeRun(itemAt(index), index)
    const res = await complete(runId, { summary: `ran ${STEPS[index].label}`, artifacts })
    assert.equal(res.statusCode, 200, res.body)
    const stored = row(runId)
    assert.equal(stored.status, 'done', STEPS[index].label)
    assert.equal(stored.model, STUB.model, STEPS[index].label)
    assert.equal(stored.provider, STUB.provider, STEPS[index].label)
    assert.equal(stored.cost_usd, STUB.usage.cost_usd, STEPS[index].label)
  }
})

// ---- metric 3 and guardrail 3: old rows and old farms stay NULL ----

test('a row from before this change and an older farm’s result both read NULL, not 0', async () => {
  const columns = db.prepare('PRAGMA table_info(step_run)').all()
  for (const name of [...COLUMNS, 'agent_run']) {
    const column = columns.find((c) => c.name === name)
    assert.ok(column, `${name} is missing`)
    assert.equal(column.notnull, 0, `${name} must be nullable`)
    assert.equal(column.dflt_value, null, `${name} must have no default`)
  }

  const oldRow = activeRun(itemAt(OPTIONS_STEP_INDEX), OPTIONS_STEP_INDEX)
  db.prepare("UPDATE step_run SET status = 'done', ended_at = datetime('now') WHERE id = ?").run(oldRow)

  const olderFarm = activeRun(itemAt(OPTIONS_STEP_INDEX), OPTIONS_STEP_INDEX)
  const res = await complete(olderFarm, { summary: 'no usage reported', artifacts: { artifact_md: '## Done' } })
  assert.equal(res.statusCode, 200, res.body)

  for (const runId of [oldRow, olderFarm]) {
    const stored = row(runId)
    assert.equal(stored.cost_usd, null)
    assert.equal(stored.agent_run, null)
    for (const key of COLUMNS) assert.equal(stored[key], null, key)
  }
})

// ---- metric 5: no agent, 0 tokens, labelled ----

const zeros = { agent_run: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 }
const figuresOf = (stored) => Object.fromEntries(['agent_run', ...COLUMNS].map((key) => [key, stored[key]]))

test('a deploy-log Deploy the farm reports as non-agent stores 0, labelled non-agent', async () => {
  const runId = activeRun(itemAt(DEPLOY_STEP_INDEX), DEPLOY_STEP_INDEX)
  const usage = { agent_run: false, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 }
  const res = await complete(runId, { summary: 'deployed (code only)', artifacts: { artifact_md: 'ok', verdict: { verdict: 'pass' }, usage } })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(figuresOf(row(runId)), zeros)
  assert.equal(row(runId).model, null) // no agent ran, so no model
})

test('a job Execute stores 0, labelled non-agent, with no usage sent at all', async () => {
  const runId = activeRun(itemAt(EXECUTE_STEP_INDEX), EXECUTE_STEP_INDEX)
  const res = await complete(runId, { summary: 'ran 2 commands', artifacts: { artifact_md: 'job log' } })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(figuresOf(row(runId)), zeros)
})

test('the File items server step stores 0, labelled non-agent', async () => {
  const label = STEPS[FILE_ITEMS_STEP_INDEX].label
  const real = orchestrator.SERVER_STEP_BEHAVIOR[label]
  orchestrator.SERVER_STEP_BEHAVIOR[label] = async () => ({ summary: 'filed 0 items' })
  try {
    const id = itemAt(FILE_ITEMS_STEP_INDEX)
    orchestrator.kick(id)
    let run
    for (let i = 0; i < 100 && run?.status !== 'done'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      run = db.prepare('SELECT id, status FROM step_run WHERE item_id = ? AND step_index = ?').get(id, FILE_ITEMS_STEP_INDEX)
    }
    assert.equal(run?.status, 'done')
    assert.deepEqual(figuresOf(row(run.id)), zeros)
  } finally {
    orchestrator.SERVER_STEP_BEHAVIOR[label] = real
  }
})

// ---- guardrail 2: capture never fails a run ----

test('a malformed usage report completes the run and leaves every figure NULL', async () => {
  for (const usage of [{ agent_run: true, input_tokens: -5 }, { agent_run: 'yes' }, 'lots', [1, 2]]) {
    const runId = activeRun(itemAt(OPTIONS_STEP_INDEX), OPTIONS_STEP_INDEX)
    const res = await complete(runId, { summary: 'done', artifacts: { artifact_md: '## Done', usage } })
    assert.equal(res.statusCode, 200, res.body)
    const stored = row(runId)
    assert.equal(stored.status, 'done', JSON.stringify(usage))
    for (const key of COLUMNS) assert.equal(stored[key], null, `${key} for ${JSON.stringify(usage)}`)
  }
})

test('a write the CHECK refuses is swallowed: the columns stay NULL and nothing throws', () => {
  const runId = activeRun(itemAt(OPTIONS_STEP_INDEX), OPTIONS_STEP_INDEX)
  assert.equal(recordRunUsage(runId, { ...NON_AGENT, agentRun: 2 }), false)
  const stored = row(runId)
  assert.equal(stored.agent_run, null)
  for (const key of COLUMNS) assert.equal(stored[key], null, key)
  assert.equal(stored.status, 'active')
})

test('cleanUsage reads only own keys and never a prototype’s', () => {
  const inherited = Object.create({ agent_run: true, ...STUB.usage })
  assert.equal(cleanUsage(inherited, STEPS[OPTIONS_STEP_INDEX]).agentRun, null)
  assert.equal(cleanUsage(null, STEPS[OPTIONS_STEP_INDEX]).cost_usd, null)
})

// ---- guardrail 1: no item route returns a figure ----

test('item responses carry no token or cost keys', async () => {
  const id = itemAt(OPTIONS_STEP_INDEX)
  const runId = activeRun(id, OPTIONS_STEP_INDEX)
  await complete(runId, { summary: 'proposed', artifacts: stubArtifacts() })
  const forbidden = /"(input_tokens|output_tokens|cache_read_tokens|cache_write_tokens|cost_usd|agent_run|inputTokens|outputTokens|cost)"\s*:/
  for (const url of ['/api/items', `/api/items/${id}/artifacts/${OPTIONS_STEP_INDEX}`, `/api/items/${id}/steps/${OPTIONS_STEP_INDEX}/output`]) {
    const res = await app.inject({ method: 'GET', url, headers: { cookie: admin.cookie } })
    assert.equal(res.statusCode, 200, `${url}: ${res.body}`)
    assert.doesNotMatch(res.body, forbidden, url)
    assert.ok(!res.body.includes(String(STUB.usage.cost_usd)), url)
  }
})

// ---- guardrail 4: HZ-549's contract is unchanged ----

test('domain/productivity.schema.json is byte-identical to HZ-549’s (454bb71)', () => {
  const bytes = readFileSync(path.join(REPO_ROOT, 'domain/productivity.schema.json'))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '88a26d7a6be2952979f8fae49114c75ded9283499ec65e7866de6be3ae8c746a')
})
