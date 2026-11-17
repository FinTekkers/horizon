// HO-852 metric lines 2, 3 and 4, and guardrail 3. With a canvas frozen
// through the real POST /move, the /steps/run inputs of Plan options,
// Implement and Automated review each carry it, found by label, right after
// golden cases. Automated review also carries every shot of the implement
// run's publish — same, changed and new, phone included, named by commit —
// and the design_canvas field the farm's role note keys on. A failed or empty
// screenshot read still dispatches. An item approved without design carries
// no canvas and no design_canvas anywhere, a Task carries none on any step,
// and the review only reads from GitHub: nothing is approved or promoted.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-design-spec-inputs-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.GITHUB_TOKEN = 'test-token'
for (const key of ['FARM_STEP_INDEXES', 'GITHUB_WEBHOOK_SECRET', 'HORIZON_REPO', 'WA_NOTIFY_ENABLED']) delete process.env[key]

// Every call: the farm's /steps/run bodies, and each GitHub call's method and
// URL. GitHub answers 500 on the artifacts ref when `failRef` is set.
const posts = []
const github = []
let failRef = false
globalThis.fetch = async (url, opts = {}) => {
  const href = String(url)
  if (href.includes('/steps/run')) posts.push(JSON.parse(opts.body))
  if (href.includes('api.github.com')) {
    github.push({ method: (opts.method || 'GET').toUpperCase(), url: href })
    if (failRef && href.includes('/git/ref/')) return { ok: false, status: 500, json: async () => ({}), text: async () => '' }
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const gh = await import('../src/github.js')
const golden = await import('../src/goldenCases.js')
const spec = await import('../src/designSpec.js')
const { REVIEW_SHOTS_LABEL } = await import('../src/screenshots.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { canvasUrlFor } = await import('../../domain/js/designCanvas.js')
const { IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX, STEPS, kindStepIndex, requiredStepIndex, stepKeyAt, stepsFor } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
orchestrator.init({ info() {}, warn() {}, error() {} })
const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)
await app.ready()

const FIRST_GATE = requiredStepIndex('Approve & prioritize this work')
const PLAN_OPTIONS = requiredStepIndex('Plan options & trade-offs (pros / cons)')
const TASK_GATE = kindStepIndex('Approve & prioritize', 'task')
const TASK_ANCHOR = kindStepIndex("How we'll verify", 'task')
const DESIGN = (anchor) => ({ id: 'design-screens', label: 'Design the screens', kind: 'opening', anchor, persona: null, output: 'design', applies: { labels: ['design'], repos: [], paths: [] } })
const GOLDEN = { id: 'golden-cases', label: 'Golden test cases', kind: 'opening', anchor: 1, persona: null, output: 'golden_cases', applies: { labels: ['design'], repos: [], paths: [] } }
const CASES = [{ id: 'c1', inputs: { x: 1 }, measure: 'y', expected: 2, tolerance: { abs: 0.5 }, source: 'spec#one' }]
const SHOT_COMMIT = 'a'.repeat(40)
const canvasLine = (slug) => `**Canvas:** [Open the design canvas](${canvasUrlFor(slug)}) · slug \`${slug}\` · version 1\n\nThe board.`

const projectId = Number(db.prepare("INSERT INTO project (name, enabled, definitions_enabled) VALUES ('Design spec inputs', 1, 1)").run().lastInsertRowid)
db.prepare(
  "INSERT INTO knowledge_doc (project_id, slug, repo, path, source_sha, status, sections_json, extracted_at) VALUES (?, 'spec', 'o/r', 'spec.pdf', 'abc', 'extracted', ?, datetime('now'))",
).run(projectId, JSON.stringify([{ id: 'one', title: '1 One', page: 1 }]))

function seed(id, { kind = 'change', withGolden = true, repo = null } = {}) {
  const anchor = kind === 'change' ? 1 : TASK_ANCHOR
  const subs = kind === 'change' && withGolden ? [GOLDEN, DESIGN(anchor)] : [DESIGN(anchor)]
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id, substeps_json, repo) VALUES (?, ?, 'Medium', ?, ?, ?, ?, ?)").run(
    id,
    `Item ${id}`,
    kind === 'change' ? FIRST_GATE : TASK_GATE,
    kind,
    projectId,
    JSON.stringify(subs),
    repo,
  )
  if (subs.includes(GOLDEN)) {
    db.prepare("INSERT INTO step_run (item_id, step_index, substep_id, attempt, agent, status, artifact) VALUES (?, 1, 'golden-cases', 1, 'PM', 'done', ?)").run(
      id,
      '```json golden-cases\n' + JSON.stringify({ cases: CASES }) + '\n```',
    )
  }
  return Number(
    db
      .prepare("INSERT INTO step_run (item_id, step_index, substep_id, attempt, agent, status, artifact) VALUES (?, ?, 'design-screens', 1, 'Design', 'done', ?)")
      .run(id, anchor, canvasLine(`canvas-${id.toLowerCase()}`)).lastInsertRowid,
  )
}
const approve = (id, body) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/move`, headers: { cookie, 'x-human-key': pin }, payload: { action: 'approve', from: stepKeyAt(FIRST_GATE), ...body } })

async function waitForPost(id, stepIndex) {
  const deadline = Date.now() + 3000
  const find = () => posts.find((p) => p.item.id === id && p.step.index === stepIndex)
  while (!find() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  return find() ?? null
}
// Puts the item on `stepIndex` and dispatches it, as a walk there would.
async function dispatchAt(id, stepIndex) {
  orchestrator.cancel(id)
  db.prepare('UPDATE work_item SET cursor = ?, paused = 0 WHERE id = ?').run(stepIndex, id)
  orchestrator.kick(id)
  const body = await waitForPost(id, stepIndex)
  orchestrator.cancel(id)
  assert.ok(body, `${STEPS[stepIndex].label} was dispatched`)
  return body
}
const labels = (body) => body.artifacts.map((a) => a.label)

test('metric 2: freeze through POST /move, then Plan options, Implement and Automated review each carry the canvas right after golden cases', async () => {
  const runId = seed('IN-CHAIN')
  const goldenHash = golden.hashOf(CASES)
  const res = await approve('IN-CHAIN', { goldenHash, designRunId: runId })
  assert.equal(res.statusCode, 200, res.body)

  // The approve itself walks on to Plan options, which has no golden input:
  // the canvas sits where golden cases would go.
  const options = await waitForPost('IN-CHAIN', PLAN_OPTIONS)
  orchestrator.cancel('IN-CHAIN')
  assert.ok(options, 'Plan options was dispatched by the approve')
  const optionsLabels = labels(options)
  assert.ok(!optionsLabels.includes(golden.APPROVED_ARTIFACT_LABEL))
  const at = optionsLabels.indexOf(spec.CANVAS_LABEL)
  assert.ok(at >= 0, 'Plan options carries the canvas')
  assert.ok(options.artifacts[at].content.includes(canvasUrlFor('canvas-in-chain')))
  assert.ok(!Object.hasOwn(options, 'design_canvas'), 'only Automated review gets the design_canvas field')

  gh.setScreenshotSnapshotForTest({})
  for (const stepIndex of [IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX]) {
    const body = await dispatchAt('IN-CHAIN', stepIndex)
    const names = labels(body)
    const goldenAt = names.indexOf(golden.APPROVED_ARTIFACT_LABEL)
    assert.ok(goldenAt >= 0, `${STEPS[stepIndex].label} carries golden cases`)
    assert.equal(names.indexOf(spec.CANVAS_LABEL), goldenAt + 1, `${STEPS[stepIndex].label}: the canvas is right after golden cases`)
    assert.ok(body.artifacts[goldenAt + 1].content.includes(canvasUrlFor('canvas-in-chain')))
  }
  gh.setScreenshotSnapshotForTest(null)
})

test('metric 3: the review carries every shot — same, changed and new — with its viewport, phone included, the commit, and design_canvas', async () => {
  const runId = seed('IN-SHOTS', { withGolden: false, repo: 'o/r' })
  assert.equal((await approve('IN-SHOTS', { designRunId: runId })).statusCode, 200)
  const files = {}
  for (const name of ['board--desktop--light', 'board--phone--light', 'list--phone--dark']) files[`e2e/__screenshots__/${name}.png`] = { sha: 'b'.repeat(40), size: 10 }
  gh.setScreenshotSnapshotForTest({
    'o/r#IN-SHOTS': {
      commit: SHOT_COMMIT,
      results: {
        shots: [
          { name: 'board--desktop--light', status: 'same', diffRatio: 0 },
          { name: 'board--phone--light', status: 'changed', diffRatio: 0.2, diff: 'e2e/__screenshots__/diff/board--phone--light.png' },
          { name: 'list--phone--dark', status: 'new' },
        ],
      },
      files,
    },
  })
  github.length = 0
  const body = await dispatchAt('IN-SHOTS', REVIEW_STEP_INDEX)
  gh.setScreenshotSnapshotForTest(null)

  const names = labels(body)
  assert.equal(names.indexOf(REVIEW_SHOTS_LABEL), names.indexOf(spec.CANVAS_LABEL) + 1)
  const shots = body.artifacts.find((a) => a.label === REVIEW_SHOTS_LABEL)
  assert.deepEqual(Object.keys(shots).sort(), ['content', 'label'], 'the farm gets a plain input, nothing extra')
  assert.ok(shots.content.includes(SHOT_COMMIT), 'the commit of the implement run’s publish is named')
  for (const row of ['| board | desktop | light | same |', '| board | phone | light | changed |', '| list | phone | dark | new |']) {
    assert.ok(shots.content.includes(row), `listed: ${row}`)
  }
  assert.deepEqual(body.design_canvas, { canvas_url: canvasUrlFor('canvas-in-shots'), shots_commit: SHOT_COMMIT })

  // Guardrail 3: the review only read. No GitHub write, nothing near
  // e2e-baseline, and no screenshot approval recorded.
  assert.ok(github.every((call) => call.method === 'GET'), JSON.stringify(github))
  assert.ok(!github.some((call) => call.url.includes('e2e-baseline')))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM screenshot_approval WHERE item_id = ?').get('IN-SHOTS').n, 0)
})

test('metric 3: a failed or empty screenshot read is said in the input, and the review is still dispatched', async () => {
  const runId = seed('IN-NOSHOTS', { withGolden: false, repo: 'o/r' })
  assert.equal((await approve('IN-NOSHOTS', { designRunId: runId })).statusCode, 200)

  failRef = true
  const failed = await dispatchAt('IN-NOSHOTS', REVIEW_STEP_INDEX)
  failRef = false
  const failedShots = failed.artifacts.find((a) => a.label === REVIEW_SHOTS_LABEL)
  assert.match(failedShots.content, /could not be read: could not read e2e-artifacts\/in-noshots \(GitHub returned 500\)/)
  assert.deepEqual(failed.design_canvas, { canvas_url: canvasUrlFor('canvas-in-noshots'), shots_commit: null })

  posts.length = 0
  gh.setScreenshotSnapshotForTest({})
  const empty = await dispatchAt('IN-NOSHOTS', REVIEW_STEP_INDEX)
  gh.setScreenshotSnapshotForTest(null)
  assert.match(empty.artifacts.find((a) => a.label === REVIEW_SHOTS_LABEL).content, /published no screenshots/)
  assert.equal(empty.design_canvas.shots_commit, null)
})

test('metric 4: approved without design, Plan options, Implement and Automated review carry no canvas and no design_canvas', async () => {
  seed('IN-SKIP', { withGolden: false })
  const res = await approve('IN-SKIP', { designSkipReason: 'Back-end only.' })
  assert.equal(res.statusCode, 200, res.body)
  const options = await waitForPost('IN-SKIP', PLAN_OPTIONS)
  orchestrator.cancel('IN-SKIP')
  gh.setScreenshotSnapshotForTest({})
  const bodies = [options, await dispatchAt('IN-SKIP', IMPLEMENT_STEP_INDEX), await dispatchAt('IN-SKIP', REVIEW_STEP_INDEX)]
  gh.setScreenshotSnapshotForTest(null)
  for (const body of bodies) {
    assert.ok(!labels(body).includes(spec.CANVAS_LABEL), `${body.step.label}: no canvas`)
    assert.ok(!labels(body).includes(REVIEW_SHOTS_LABEL), `${body.step.label}: no shots`)
    assert.ok(!Object.hasOwn(body, 'design_canvas'), `${body.step.label}: no design_canvas`)
  }
})

test('Task rule: a Task’s frozen canvas reaches none of its steps, since a Task has no Plan options, Implement or Automated review', async () => {
  const runId = seed('IN-TASK', { kind: 'task' })
  const ok = await app.inject({
    method: 'POST',
    url: '/api/items/IN-TASK/move',
    headers: { cookie, 'x-human-key': pin },
    payload: { action: 'approve', from: stepKeyAt(TASK_GATE), designRunId: runId },
  })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.ok(spec.approvedDesign('IN-TASK').canvasUrl)
  const taskSteps = stepsFor('task').map((s) => s.index)
  assert.ok(spec.CANVAS_STEP_INDEXES.every((i) => !taskSteps.includes(i)), 'no canvas step is a Task step')
  for (const step of stepsFor('task').filter((s) => s.kind === 'agent' && s.index > TASK_GATE && s.runsIn === 'farm')) {
    assert.equal(spec.canvasInput('IN-TASK', step.index), null, `${step.label} gets no canvas`)
  }
  const first = await waitForPost('IN-TASK', TASK_GATE + 1)
  orchestrator.cancel('IN-TASK')
  assert.ok(first, 'the Task walked on to its next step')
  assert.ok(!labels(first).includes(spec.CANVAS_LABEL))
  assert.ok(!Object.hasOwn(first, 'design_canvas'))
})
