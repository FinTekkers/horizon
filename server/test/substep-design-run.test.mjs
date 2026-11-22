// HO-850 metric line 3: a `design` sub-step run. Sent back through the real
// POST /move, its run writes step_run.substep_id and counts its own attempts;
// the farm task names the sub-step and its own artifact URL; the canvas link
// it stores is served by both artifact routes with ?substep=, and never by the
// plain route. A second round is attempt 2 and is told the canvas to update.
// A run that is not a sub-step keeps substep_id NULL and today's payload.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-design-run-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.FARM_RECOVERY_POLL_MS = String(60 * 60 * 1000)
for (const key of ['FARM_STEP_INDEXES', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'HORIZON_REPO']) delete process.env[key]
// A project's definitions file lives in the farm dir, never in the repo
// (domain-single-source.test.mjs: domain/steps.json is the only steps.json).
const DESIGN = { id: 'design-screens', label: 'Design the screens', kind: 'opening', anchor: 1, output: 'design', applies: { labels: ['design'] } }
process.env.HORIZON_FARM_DIR = mkdtempSync(join(tmpdir(), 'horizon-design-run-farm-'))
mkdirSync(join(process.env.HORIZON_FARM_DIR, 'projects', 'design-run'), { recursive: true })
writeFileSync(join(process.env.HORIZON_FARM_DIR, 'projects', 'design-run', 'steps.json'), JSON.stringify({ substeps: [DESIGN] }))

const posts = []
globalThis.fetch = async (url, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : null
  if (String(url).includes('/steps/run')) posts.push(body)
  return { ok: true, status: 200, json: async () => ({}) }
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const substeps = await import('../src/substeps.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { requiredStepIndex, stepKeyAt } = await import('../../domain/js/lifecycle.js')
const { canvasUrlFor } = await import('../../domain/js/designCanvas.js')

store.purgeDemoItems()
orchestrator.init({ info: () => {}, warn: () => {}, error: () => {} })
const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)
await app.ready()

const FIRST_GATE = requiredStepIndex('Approve & prioritize this work')
const SNAPSHOT = JSON.stringify([{ ...DESIGN, persona: null, applies: { labels: ['design'], repos: [], paths: [] } }])
const SLUG = 'horizon-d-1-design-screens'
const CANVAS = canvasUrlFor(SLUG)
const canvasArtifact = (version, action) =>
  `**Canvas:** [Open the design canvas](${CANVAS}) · slug \`${SLUG}\` · version ${version}\n\n${action}\n\nThe board and the item page.`

const projectId = Number(db.prepare("INSERT INTO project (name, enabled, definitions_enabled) VALUES ('Design run', 1, 1)").run().lastInsertRowid)

const headers = { cookie, 'x-human-key': pin }
const sendBackToDesign = (id) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/move`, headers, payload: { stepKey: `${stepKeyAt(1)}#${DESIGN.id}`, from: stepKeyAt(FIRST_GATE), note: 'draw the screens' } })
const get = (url) => app.inject({ method: 'GET', url, headers: { cookie } })
const runs = (id) => db.prepare('SELECT id, step_index, substep_id, attempt, status FROM step_run WHERE item_id = ? ORDER BY id').all(id)
const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor

async function waitForPost(id, count, { substep = false } = {}) {
  const deadline = Date.now() + 3000
  const mine = () => posts.filter((p) => p.item.id === id && (!substep || Object.hasOwn(p, 'substep')))
  while (mine().length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  return mine()[count - 1] ?? null
}

test('design is an opening output only', () => {
  assert.ok(substeps.SUBSTEP_OUTPUTS.includes('design'))
  assert.deepEqual(substeps.validateSubsteps({ substeps: [DESIGN] }).errors, [])
  const audit = substeps.validateSubsteps({ substeps: [{ ...DESIGN, id: 'audit-design', kind: 'audit', anchor: 11 }] })
  assert.deepEqual(audit.substeps, [])
  assert.ok(audit.errors.some((e) => /audit output must be findings, got design/.test(e)), audit.errors.join('\n'))
})

test('a project file with a design sub-step loads, and only an item labelled design gets it', () => {
  const loaded = substeps.loadSubsteps('Design run')
  assert.deepEqual(loaded.errors, [])
  assert.deepEqual(loaded.substeps.map((s) => [s.id, s.label, s.kind, s.anchor, s.output]), [['design-screens', 'Design the screens', 'opening', 1, 'design']])
  const project = { name: 'Design run', definitions_enabled: 1 }
  assert.equal(substeps.snapshotSubsteps({ project, kind: 'change', labels: [], repo: 'o/r', desc: '' }), null)
  assert.equal(substeps.snapshotSubsteps({ project, kind: 'change', labels: ['bug'], repo: 'o/r', desc: '' }), null)
  assert.deepEqual(JSON.parse(substeps.snapshotSubsteps({ project, kind: 'change', labels: ['design'], repo: 'o/r', desc: '' })).map((s) => s.id), ['design-screens'])
  assert.equal(substeps.snapshotSubsteps({ project: { ...project, definitions_enabled: 0 }, kind: 'change', labels: ['design'], repo: 'o/r', desc: '' }), null)
})

test('a design sub-step run is tagged, served with ?substep= only, and its second round updates the same canvas', async () => {
  const id = 'D-1'
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id, substeps_json) VALUES (?, 'Design me', 'Medium', ?, ?, ?)").run(id, FIRST_GATE, projectId, SNAPSHOT)
  // The global metric step already ran once.
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, artifact) VALUES (?, 1, 1, 'PM', 'done', 'The metric artifact.')").run(id)

  // Round 1.
  const first = await sendBackToDesign(id)
  assert.equal(first.statusCode, 200, first.body)
  assert.equal(first.json().restart.attempt, 1, 'the restart names the sub-step’s own attempt')
  const body1 = await waitForPost(id, 1, { substep: true })
  assert.ok(body1, 'the design run reached the farm')
  assert.deepEqual(body1.substep, { id: 'design-screens', label: 'Design the screens', output: 'design' }, 'round 1 names no previous canvas')
  assert.equal(body1.artifact_url, `${config.UI_URL}/api/items/${id}/artifacts/1?substep=design-screens`)
  const run1 = runs(id).at(-1)
  assert.deepEqual([run1.step_index, run1.substep_id, run1.attempt, run1.status], [1, 'design-screens', 1, 'active'])
  assert.equal(body1.run_id, run1.id)

  await orchestrator.completeFarmRun(run1.id, { summary: 'drew the board', artifacts: { artifact_md: canvasArtifact(2, 'New canvas.') } })
  // The item leaves the anchor as the global flow does; walk it back to the gate.
  assert.equal(cursorOf(id), 2)
  orchestrator.cancel(id)
  db.prepare('UPDATE work_item SET cursor = ?, substep_cursor = NULL, paused = 0 WHERE id = ?').run(FIRST_GATE, id)

  for (const url of [`/api/items/${id}/artifacts/1/1?substep=design-screens`, `/api/items/${id}/artifacts/1?substep=design-screens`]) {
    const res = await get(url)
    assert.equal(res.statusCode, 200, `${url}: ${res.body}`)
    assert.match(res.headers['content-type'], /text\/html/)
    assert.ok(res.body.includes(`href="${CANVAS}"`), `${url} links the canvas`)
    assert.ok(res.body.includes('Open the design canvas'))
  }
  // Global readers filter substep_id IS NULL: the plain route serves the metric step's own artifact.
  const plain = await get(`/api/items/${id}/artifacts/1`)
  assert.equal(plain.statusCode, 200, plain.body)
  assert.ok(plain.body.includes('The metric artifact.'))
  assert.ok(!plain.body.includes(CANVAS), 'the plain route never serves the canvas')

  // Round 2: attempt 2 of the sub-step, told the canvas round 1 made.
  const second = await sendBackToDesign(id)
  assert.equal(second.statusCode, 200, second.body)
  assert.equal(second.json().restart.attempt, 2)
  const body2 = await waitForPost(id, 2, { substep: true })
  assert.equal(body2.substep.previous_canvas_url, CANVAS)
  const run2 = runs(id).at(-1)
  assert.deepEqual([run2.substep_id, run2.attempt], ['design-screens', 2])
  assert.equal(store.nextStepAttempt(id, 1).attempt, 2, 'the global step’s attempt count is unchanged')

  // A usage-limited round keeps its attempt number.
  db.prepare("UPDATE step_run SET status = 'cancelled', usage_limit_hit = 1 WHERE id = ?").run(run2.id)
  assert.deepEqual(
    (({ attempt, keepsAttempt }) => ({ attempt, keepsAttempt }))(store.nextStepAttempt(id, 1, 'design-screens')),
    { attempt: 2, keepsAttempt: true },
  )
  db.prepare("UPDATE step_run SET status = 'active', usage_limit_hit = 0 WHERE id = ?").run(run2.id)

  await orchestrator.completeFarmRun(run2.id, { summary: 'moved the gate panel', artifacts: { artifact_md: canvasArtifact(5, 'Updated the previous canvas (version 2 → 5).') } })
  const latest = await get(`/api/items/${id}/artifacts/1?substep=design-screens`)
  assert.ok(latest.body.includes('version 5') && latest.body.includes('Updated the previous canvas'))
  const round1 = await get(`/api/items/${id}/artifacts/1/1?substep=design-screens`)
  assert.equal(round1.statusCode, 200)
  assert.ok(round1.body.includes('version 2') && round1.body.includes('New canvas.'))
})

test('a run that is not a sub-step keeps substep_id NULL and today’s payload', async () => {
  const id = 'P-1'
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES (?, 'Plain', 'Medium', 1, ?)").run(id, projectId)
  orchestrator.kick(id)
  const body = await waitForPost(id, 1)
  orchestrator.cancel(id)
  assert.ok(body, 'the plain run reached the farm')
  assert.equal(Object.hasOwn(body, 'substep'), false)
  assert.equal(body.artifact_url, `${config.UI_URL}/api/items/${id}/artifacts/1`)
  assert.deepEqual(runs(id).map((r) => r.substep_id), [null])
})

// HZ-938 metric 3: every round's stored record names the tool that drew it
// and its design system, and a fallback round records `html` with the tool it
// fell back from. Round 1 Studio, round 2 Claude Design, round 3 a Horizon
// page because Studio could not run (a tool switch: a new link, the new tool).
// The project's web-page visuals switch stays off: the design page is stored
// and served all the same (metric 2), and the next round is told only a link
// its own tool can update.
test('every round records its tool and design system; a fallback round records html and links the design page', async () => {
  const id = 'D-2'
  const { FALLBACK_TEXT, claudeProjectUrlFor } = await import('../../domain/js/designCanvas.js')
  const designSpec = await import('../src/designSpec.js')
  const PROJECT_ID = '0b9f3c2e-5d41-4c6a-9e7b-2f1a8c3d4e5f'
  const CLAUDE = claudeProjectUrlFor(PROJECT_ID)
  const SHA = 'a'.repeat(64)
  assert.equal(db.prepare('SELECT visual_pages_enabled FROM project WHERE id = ?').get(projectId).visual_pages_enabled, 0)
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id, substeps_json) VALUES (?, 'Compare tools', 'Medium', ?, ?, ?)").run(id, FIRST_GATE, projectId, SNAPSHOT)
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, artifact) VALUES (?, 1, 1, 'PM', 'done', 'The metric artifact.')").run(id)

  async function round(n, artifacts) {
    const moved = await sendBackToDesign(id)
    assert.equal(moved.statusCode, 200, moved.body)
    const body = await waitForPost(id, n, { substep: true })
    assert.ok(body, `round ${n} reached the farm`)
    await orchestrator.completeFarmRun(runs(id).at(-1).id, { summary: `round ${n}`, artifacts })
    assert.equal(db.prepare('SELECT paused FROM work_item WHERE id = ?').get(id).paused, 0, `round ${n} never pauses the item`)
    orchestrator.cancel(id)
    db.prepare('UPDATE work_item SET cursor = ?, substep_cursor = NULL, paused = 0 WHERE id = ?').run(FIRST_GATE, id)
    return body
  }

  await round(1, { artifact_md: canvasArtifact(2, 'New canvas.'), design: { tool: 'studio', system: 'fds', fallback_from: null } })
  const body2 = await round(2, {
    artifact_md: `**Claude Design:** [Open the Claude Design project](${CLAUDE}) · project \`${PROJECT_ID}\` · round 2\n\nNew Claude Design project.`,
    design: { tool: 'claude', system: 'claude-design', fallback_from: null },
  })
  assert.equal(body2.substep.previous_canvas_url, CANVAS, 'round 2 is told the Studio canvas')
  const body3 = await round(3, {
    artifact_md: `**Design page:** [Open the design page](/api/items/${id}/design-page) · round 1\n\nNew design page.`,
    design: { tool: 'html', system: 'horizon-production', fallback_from: 'studio' },
    design_page: { round: 1, sha256: SHA, bytes: 120, shots: { desktop: 'page-r1-desktop.png', phone: 'page-r1-phone.png' } },
  })
  assert.equal(body3.substep.previous_canvas_url, CLAUDE, 'round 3 is told the Claude Design project')

  const records = db
    .prepare('SELECT round, kind, design_tool, design_system, fallback_from FROM substep_round WHERE item_id = ? ORDER BY round')
    .all(id)
    .map((r) => [r.round, r.kind, r.design_tool, r.design_system, r.fallback_from])
  assert.deepEqual(records, [
    [1, 'run', 'studio', 'fds', null],
    [2, 'run', 'claude', 'claude-design', null],
    [3, 'run', 'html', 'horizon-production', 'studio'],
  ])
  const events = db.prepare('SELECT text FROM event WHERE item_id = ?').all(id).map((e) => e.text)
  assert.ok(events.includes(`“${DESIGN.label}”: ${FALLBACK_TEXT.studio}`), events.join('\n'))
  assert.deepEqual(db.prepare('SELECT round, desktop_png FROM item_design_page_round WHERE item_id = ?').all(id), [{ round: 1, desktop_png: 'page-r1-desktop.png' }])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM item_page_round WHERE item_id = ?').get(id).n, 0, 'the web-page visual is untouched')

  const res = await get('/api/items')
  assert.equal(res.statusCode, 200, res.body)
  const sub = res.json().items.find((it) => it.id === id).substeps.find((s) => s.id === DESIGN.id)
  assert.deepEqual(
    sub.rounds.map((r) => [r.round, r.designTool, r.designSystem, r.fallbackFrom, r.canvasUrl, r.designPageUrl ?? null, r.shots ?? null]),
    [
      [1, 'studio', 'fds', null, CANVAS, null, null],
      [2, 'claude', 'claude-design', null, CLAUDE, null, null],
      [3, 'html', 'horizon-production', 'studio', null, `/api/items/${id}/design-page`, { desktop: 'page-r1-desktop.png', phone: 'page-r1-phone.png' }],
    ],
  )
  const pending = designSpec.pendingCanvas(store.getItem(id))
  assert.deepEqual([pending.tool, pending.url], ['html', `/api/items/${id}/design-page`], 'the first gate can approve a design page')
})

test('a design value that does not check out is dropped with an event, never recorded', async () => {
  const id = 'D-3'
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id, substeps_json) VALUES (?, 'Bad tool', 'Medium', ?, ?, ?)").run(id, FIRST_GATE, projectId, SNAPSHOT)
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, artifact) VALUES (?, 1, 1, 'PM', 'done', 'm')").run(id)
  assert.equal((await sendBackToDesign(id)).statusCode, 200)
  assert.ok(await waitForPost(id, 1, { substep: true }))
  // A Studio line claimed as an html fallback: the line and the tool disagree.
  await orchestrator.completeFarmRun(runs(id).at(-1).id, {
    summary: 'r',
    artifacts: { artifact_md: canvasArtifact(2, 'New canvas.'), design: { tool: 'html', system: 'horizon-production', fallback_from: 'studio' } },
  })
  orchestrator.cancel(id)
  const row = db.prepare('SELECT design_tool, design_system, fallback_from FROM substep_round WHERE item_id = ?').get(id)
  assert.deepEqual(row, { design_tool: null, design_system: null, fallback_from: null })
  const events = db.prepare('SELECT text FROM event WHERE item_id = ?').all(id).map((e) => e.text)
  assert.ok(events.some((t) => t.startsWith(`did not record which tool drew “${DESIGN.label}”`)), events.join('\n'))
})
