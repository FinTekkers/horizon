// HO-853 guardrail 3 ("No canvas credential reaches the browser, only the
// canvas link. Render a link only if it is an `https:` URL"), and metric line
// 2's served half:
// - domain/js/designRounds.js safeCanvasUrl keeps only an absolute https: URL
//   with no user or password, the rule both the server and the UI draw
//   canvas links through.
// - GET /api/items serves each design round's own canvas link, read off
//   its run's canvas line, and nothing else of the run or the snapshot: a
//   credential-like key seeded into the snapshot (`canvasToken`) and a run
//   whose canvas line is not https never reach the response body.
// - While the item is at its design sub-step, the round in flight is served
//   with its brief — the send-back note (metric line 4).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

globalThis.fetch = async () => {
  throw new Error('domain-design-rounds test: no network')
}
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-domain-design-rounds-')), 'test.db')
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO', 'WA_NOTIFY_ENABLED']) delete process.env[key]
process.env.MOCK_STEP_LATENCY_MS = String(60 * 60 * 1000)

const { safeCanvasUrl, roundNumberOf, latestRoundOf, roundsOf, designSubstepFor } = await import('../../domain/js/designRounds.js')
const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const rounds = await import('../src/designRounds.js')
const { canvasUrlFor } = await import('../../domain/js/designCanvas.js')
const { requiredStepIndex, stepKeyAt } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)
await app.ready()

test('safeCanvasUrl keeps only an absolute https: URL with no credentials', () => {
  assert.equal(safeCanvasUrl('https://blueprint-studio.internalmeta.com/canvas/abc'), 'https://blueprint-studio.internalmeta.com/canvas/abc')
  assert.equal(safeCanvasUrl('https://claude.ai/artifact/4auN6UaMc165dSRfDz4sL5'), 'https://claude.ai/artifact/4auN6UaMc165dSRfDz4sL5')
  for (const bad of [
    'http://blueprint-studio.internalmeta.com/canvas/abc',
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '/canvas/abc',
    '//blueprint-studio.internalmeta.com/canvas/abc',
    'https://user:secret@blueprint-studio.internalmeta.com/canvas/abc',
    'https://token@blueprint-studio.internalmeta.com/canvas/abc',
    'not a url',
    '',
    null,
    undefined,
    42,
    { href: 'https://x.test/' },
  ]) {
    assert.equal(safeCanvasUrl(bad), null, String(bad))
  }
})

test('the round readers: the round in flight wins, else the latest; none for a sub-step without rounds', () => {
  const sub = { id: 'design-screens', rounds: [{ round: 1, kind: 'run' }, { round: 2, kind: 'run' }], pendingRound: null }
  assert.equal(roundNumberOf(sub), 2)
  assert.equal(latestRoundOf(sub).round, 2)
  assert.equal(roundNumberOf({ ...sub, pendingRound: { round: 3, kind: 'run', brief: 'x' } }), 3)
  assert.equal(roundNumberOf({ id: 'golden-cases' }), null)
  assert.deepEqual(roundsOf({ id: 'golden-cases' }), [])
  assert.equal(latestRoundOf(null), null)
  const item = { designSpec: { substepId: 'design-screens' }, substeps: [{ id: 'golden-cases' }, sub] }
  assert.equal(designSubstepFor(item), sub)
  assert.equal(designSubstepFor({ substeps: [sub] }), null, 'an item with no designSpec has no design panel')
})

// ---- served payload ----

const FIRST_GATE = requiredStepIndex('Approve & prioritize this work')
const DESIGN_ID = 'design-screens'
const TOKEN = 'sk-canvas-SECRET-0123456789'
const canvasLine = (url, slug, version) => `**Canvas:** [Open the design canvas](${url}) · slug \`${slug}\` · version ${version}\n\nThe board.`
const projectId = Number(db.prepare("INSERT INTO project (name, enabled, definitions_enabled) VALUES ('Design rounds payload', 1, 1)").run().lastInsertRowid)

function seed(id) {
  const snapshot = [
    { id: DESIGN_ID, label: 'Design the screens', kind: 'opening', anchor: 1, persona: null, output: 'design', canvasToken: TOKEN, applies: { labels: [], repos: [], paths: [] } },
  ]
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id, substeps_json) VALUES (?, ?, 'Medium', ?, 'change', ?, ?)").run(
    id,
    `Item ${id}`,
    FIRST_GATE,
    projectId,
    JSON.stringify(snapshot),
  )
}
const writeRun = (id, artifact) =>
  Number(
    db
      .prepare("INSERT INTO step_run (item_id, step_index, substep_id, attempt, agent, status, artifact) VALUES (?, 1, ?, 1, 'Design', 'done', ?)")
      .run(id, DESIGN_ID, artifact).lastInsertRowid,
  )
const listItems = () => app.inject({ method: 'GET', url: '/api/items?v=2', headers: { cookie } })
const viewOf = async (id) => (await listItems()).json().items.find((it) => it.id === id)

test('each round carries its own run’s canvas link; a credential in the snapshot or a non-https link is never served', async () => {
  seed('DR-1')
  const one = writeRun('DR-1', canvasLine(canvasUrlFor('round-one'), 'round-one', 1))
  const two = writeRun('DR-1', canvasLine(canvasUrlFor('round-two'), 'round-two', 2))
  // A forged first line with a plain-http link and a token in its query.
  const three = writeRun('DR-1', canvasLine(`http://blueprint-studio.internalmeta.com/canvas/round-three?token=${TOKEN}`, 'round-three', 3))
  rounds.recordRound('DR-1', DESIGN_ID, { kind: 'run', runId: one, brief: 'Draw the board.', whatChanged: 'New canvas.' })
  rounds.recordRound('DR-1', DESIGN_ID, { kind: 'run', runId: two, brief: 'Bigger filters.', whatChanged: 'Filters moved up.' })
  rounds.recordRound('DR-1', DESIGN_ID, { kind: 'run', runId: three, brief: 'Third.', whatChanged: 'x' })

  const res = await listItems()
  assert.equal(res.statusCode, 200, res.body)
  const body = res.body
  const design = res.json().items.find((it) => it.id === 'DR-1').substeps.find((s) => s.id === DESIGN_ID)
  assert.deepEqual(
    design.rounds.map((r) => [r.round, r.brief, r.canvasUrl]),
    [
      [1, 'Draw the board.', canvasUrlFor('round-one')],
      [2, 'Bigger filters.', canvasUrlFor('round-two')],
      [3, 'Third.', null],
    ],
  )
  assert.equal(design.pendingRound, null)
  assert.ok(!body.includes('canvasToken'), 'the snapshot’s credential-like key is not served')
  assert.ok(!body.includes(TOKEN), 'no credential value anywhere in the body')
  assert.ok(!body.includes('http://blueprint-studio'), 'a non-https canvas link is not served')
})

test('metric line 4: a send-back to the design sub-step serves the round in flight with the note as its brief', async () => {
  seed('DR-2')
  const run = writeRun('DR-2', canvasLine(canvasUrlFor('dr-two'), 'dr-two', 1))
  rounds.recordRound('DR-2', DESIGN_ID, { kind: 'run', runId: run, brief: 'Draw it.', whatChanged: 'New canvas.' })
  const moves = (await viewOf('DR-2')).moves
  const key = moves.targets.map((t) => t.stepKey).find((k) => k.endsWith(`#${DESIGN_ID}`))
  assert.ok(key, 'the snapshot lists the design sub-step as a send-back target')
  const res = await app.inject({
    method: 'POST',
    url: '/api/items/DR-2/move',
    headers: { cookie, 'x-human-key': pin },
    payload: { stepKey: key, from: stepKeyAt(FIRST_GATE), note: 'Make the empty state friendlier' },
  })
  assert.equal(res.statusCode, 200, res.body)
  const design = (await viewOf('DR-2')).substeps.find((s) => s.id === DESIGN_ID)
  assert.deepEqual(design.pendingRound, { round: 2, kind: 'run', brief: 'Make the empty state friendlier' })
})
