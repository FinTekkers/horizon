// HZ-930: a repo's 'web guidance' mark. Default off. The owner sets it in
// Admin (the PIN-gated marks route) or lists the repo in its project's
// steps.json `webGuidance.repos`; either one adds `web_guidance: true` to the
// repo's next Eng implement /steps/run body, read fresh at dispatch. No other
// step, check or job body ever carries the key, and an unmarked repo's body
// never carries it at all (absent, not false).

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-web-guidance-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-web-guidance-home-'))
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire here
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX, STEPS } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')
const substeps = await import('../src/substeps.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
const alice = loginFixtureUser(auth, config, { email: 'alice@example.com', name: 'Alice Example' })
await app.ready()
after(() => app.close())

const projectId = db.prepare("INSERT INTO project (name, enabled) VALUES ('Web Guide', 1)").run().lastInsertRowid
for (const [repo, prefix] of [
  ['acme/site', 'WS'],
  ['acme/listed', 'WL'],
  ['acme/plain', 'WP'],
]) {
  db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(projectId, repo, prefix)
  store.setRepoCheckCommands(projectId, repo, { test: 'npm test' })
}

// The project's steps.json, swapped per test through substeps' one file seam.
let stepsJson = null
const realReadFile = substeps.deps.readFile
substeps.deps.readFile = (file) => {
  if (file.endsWith(join('web-guide', 'steps.json'))) {
    if (stepsJson === null) throw Object.assign(new Error('no file'), { code: 'ENOENT' })
    return stepsJson
  }
  return realReadFile(file)
}
after(() => {
  substeps.deps.readFile = realReadFile
})

const calls = []
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null })
  return { ok: true, status: 200, json: async () => ({}) }
}
const stepRunFor = (id) => calls.find((c) => c.url.includes('/steps/run') && c.body?.item?.id === id)?.body

let seq = 0
// Dispatches a fresh item in `repo` at `stepIndex` and returns its /steps/run body.
async function dispatchedBody(repo, stepIndex = IMPLEMENT_STEP_INDEX) {
  const id = `WG-${++seq}`
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    `Web guidance ${seq}`,
    'Medium',
    stepIndex,
    repo,
    seq,
    projectId,
  )
  orchestrator.kick(id)
  for (let i = 0; i < 50 && !stepRunFor(id); i++) await new Promise((r) => setTimeout(r, 10))
  const body = stepRunFor(id)
  orchestrator.cancel(id)
  assert.ok(body, `no /steps/run for ${id} at step ${stepIndex}`)
  return body
}

const keyIndex = (key) => STEPS.findIndex((step) => step.key === key)

// pin null sends no PIN header.
const put = (payload, pin = alice.pin) =>
  app.inject({
    method: 'PUT',
    url: `/api/projects/${projectId}/repos/marks`,
    payload,
    headers: { cookie: alice.cookie, ...(pin === null ? {} : { 'x-human-key': pin }) },
  })
const column = (repo) => db.prepare('SELECT no_checks, no_deploy, web_guidance FROM project_repo WHERE repo = ?').get(repo)

// ---- metric 2: unmarked by default; a PIN PUT marks the next implement run ----

test('a repo with no setting is unmarked, and its implement body has no web_guidance key', async () => {
  assert.equal(column('acme/site').web_guidance, 0)
  assert.equal(store.getRepoConfig('acme/site').webGuidance, false)
  const body = await dispatchedBody('acme/site')
  assert.equal(Object.hasOwn(body, 'web_guidance'), false)
})

test('marking in Admin needs the PIN, and turns the skills on for the next implement run', async () => {
  const refused = await put({ repo: 'acme/site', webGuidance: true }, null)
  assert.equal(refused.statusCode, 401)
  assert.equal(column('acme/site').web_guidance, 0)

  const res = await put({ repo: 'acme/site', webGuidance: true })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), {
    ok: true,
    repo: 'acme/site',
    marks: { noChecks: false, noDeploy: false, webGuidance: true },
  })
  assert.equal((await dispatchedBody('acme/site')).web_guidance, true)
  // The other repos are untouched.
  assert.equal(Object.hasOwn(await dispatchedBody('acme/plain'), 'web_guidance'), false)
})

test('clearing the mark in Admin drops the key from the next implement run', async () => {
  assert.equal((await put({ repo: 'acme/site', webGuidance: false })).statusCode, 200)
  assert.equal(Object.hasOwn(await dispatchedBody('acme/site'), 'web_guidance'), false)
})

// ---- guardrail 4: a webGuidance-only PUT leaves the other marks alone ----

test('a webGuidance-only PUT keeps noChecks and noDeploy as they were', async () => {
  store.setRepoMarks(projectId, 'acme/plain', { noChecks: true, noDeploy: true })
  const res = await put({ repo: 'acme/plain', webGuidance: true })
  assert.deepEqual(res.json().marks, { noChecks: true, noDeploy: true, webGuidance: true })
  assert.deepEqual(column('acme/plain'), { no_checks: 1, no_deploy: 1, web_guidance: 1 })
  const cleared = await put({ repo: 'acme/plain', webGuidance: false })
  assert.deepEqual(cleared.json().marks, { noChecks: true, noDeploy: true, webGuidance: false })
  store.setRepoMarks(projectId, 'acme/plain', { noChecks: false, noDeploy: false })
})

test('a non-boolean webGuidance is 400 and stores nothing', async () => {
  const res = await put({ repo: 'acme/plain', webGuidance: 'yes' })
  assert.equal(res.statusCode, 400)
  assert.equal(column('acme/plain').web_guidance, 0)
})

// ---- metric 2: marking in steps.json, read at dispatch with no restart ----

test('a steps.json webGuidance.repos entry marks the next implement run, matched case-insensitively', async () => {
  stepsJson = null
  assert.equal(Object.hasOwn(await dispatchedBody('acme/listed'), 'web_guidance'), false)

  stepsJson = JSON.stringify({ substeps: [], webGuidance: { repos: ['ACME/Listed'] } })
  assert.equal((await dispatchedBody('acme/listed')).web_guidance, true)
  assert.equal(column('acme/listed').web_guidance, 0, 'the file never writes the DB mark')
  assert.equal(Object.hasOwn(await dispatchedBody('acme/plain'), 'web_guidance'), false)

  stepsJson = '{ not json'
  assert.equal(Object.hasOwn(await dispatchedBody('acme/listed'), 'web_guidance'), false)
  stepsJson = null
})

test('webGuidanceRepos reads only a list of non-empty strings', () => {
  for (const [text, want] of [
    [null, []],
    ['{ not json', []],
    [JSON.stringify({ substeps: [] }), []],
    [JSON.stringify({ webGuidance: { repos: 'acme/site' } }), []],
    [JSON.stringify({ webGuidance: { repos: ['acme/site', ''] } }), []],
    [JSON.stringify({ webGuidance: { repos: [' acme/site '] } }), ['acme/site']],
  ]) {
    stepsJson = text
    assert.deepEqual(substeps.webGuidanceRepos('Web Guide'), want, String(text))
  }
  stepsJson = null
  assert.deepEqual(substeps.webGuidanceRepos(null), [])
})

// ---- guardrail 4: only Eng implement runs get the key ----

test('Architect, QA-plan and review runs on a marked repo carry no web_guidance', async () => {
  await put({ repo: 'acme/site', webGuidance: true })
  for (const stepIndex of [keyIndex('change.arch-review'), keyIndex('change.qa-test-plan'), REVIEW_STEP_INDEX]) {
    const body = await dispatchedBody('acme/site', stepIndex)
    assert.equal(Object.hasOwn(body, 'web_guidance'), false, `step ${stepIndex}`)
  }
  assert.equal((await dispatchedBody('acme/site')).web_guidance, true, 'the implement run still does')
  await put({ repo: 'acme/site', webGuidance: false })
})

test('webGuidanceField is {} for every step but implement, and for an item with no repo', () => {
  store.setRepoMarks(projectId, 'acme/site', { webGuidance: true })
  const item = { repo: 'acme/site' }
  assert.deepEqual(orchestrator.webGuidanceField(item, IMPLEMENT_STEP_INDEX, 'Web Guide'), { web_guidance: true })
  for (const stepIndex of [keyIndex('change.draft-plan'), keyIndex('change.arch-review'), keyIndex('change.qa-test-plan'), REVIEW_STEP_INDEX, keyIndex('change.deploy')]) {
    assert.deepEqual(orchestrator.webGuidanceField(item, stepIndex, 'Web Guide'), {}, `step ${stepIndex}`)
  }
  assert.deepEqual(orchestrator.webGuidanceField({ repo: null }, IMPLEMENT_STEP_INDEX, 'Web Guide'), {})
  store.setRepoMarks(projectId, 'acme/site', { webGuidance: false })
})

// Command checks, conflict resolution, the Execute job (dispatchJob) and
// Preflight (dispatchCodeRun) build their own bodies. The key is written in
// one place only — webGuidanceField — and spread into the agent-step body, so
// none of those bodies can carry it.
test('web_guidance is written only by webGuidanceField, spread once into the agent-step body', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
  const hits = []
  for (const file of readdirSync(src, { recursive: true })) {
    if (!String(file).endsWith('.js')) continue
    const text = readFileSync(join(src, String(file)), 'utf8')
    for (const [i, line] of text.split('\n').entries()) {
      if (line.trim().startsWith('//')) continue
      if (line.includes('web_guidance:') || line.includes('webGuidanceField(')) hits.push(`${file}:${i + 1}: ${line.trim()}`)
    }
  }
  const orchestratorSrc = readFileSync(join(src, 'orchestrator.js'), 'utf8')
  assert.equal(hits.filter((h) => h.includes('web_guidance:')).length, 1, hits.join('\n'))
  assert.match(hits.find((h) => h.includes('web_guidance:')), /^orchestrator\.js:.*\{ web_guidance: true \}/)
  // The definition plus exactly one spread, inside dispatchToFarm's /steps/run body.
  assert.equal(hits.filter((h) => h.includes('webGuidanceField(')).length, 2, hits.join('\n'))
  const spread = orchestratorSrc.indexOf('webGuidanceField(item, stepIndex, project?.name)')
  const body = orchestratorSrc.lastIndexOf("farmFetch('/steps/run', {", spread)
  assert.ok(body > 0 && orchestratorSrc.slice(body, spread).includes('...checkCommandsField(item)'), 'spread in the agent-step body')
  for (const fn of ['function dispatchJob(', 'function dispatchCodeRun(', 'function dispatchCommandStage(']) {
    const start = orchestratorSrc.indexOf(fn)
    assert.ok(start > 0, fn)
    const end = orchestratorSrc.indexOf('\n}\n', start)
    assert.equal(orchestratorSrc.slice(start, end).includes('web_guidance'), false, fn)
  }
})
