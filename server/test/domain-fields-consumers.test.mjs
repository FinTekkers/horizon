// HZ-134's two server-side seams. Neither is a property of domain/fields.json or
// of either binding — each is a place where the derived field list meets code
// that was NOT derived, which is exactly where a cross-layer change rots.
//
//   1. Every declared `column` must be a real work_item column.
//      server/src/orchestrator.js's completeFarmRun builds
//      `UPDATE work_item SET <column> = ?` straight from the derived list, so a
//      typo in domain/fields.json surfaces as a runtime SQL error at patch time
//      — on a live item, mid-run — rather than as a test failure. Checked
//      against a REAL database via PRAGMA table_info, not by parsing db.js:
//      several of these columns arrive through its additive ALTER TABLE
//      migrations rather than the CREATE TABLE.
//
//   2. Every patchable field must have display copy. PATCH_FIELD_LABELS stays a
//      hand-written literal in orchestrator.js on purpose (guardrail 5 keeps
//      presentation out of domain/), and stepCommentBody FILTERS the patch
//      through it — so a patchable field missing from that map is written to the
//      database and silently omitted from the GitHub comment. Driven through the
//      already-exported stepCommentBody rather than by reading the map, so no new
//      export is needed and the assertion is about rendered output.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-fields-consumers-')), 'test.db')
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const orchestrator = await import('../src/orchestrator.js')
const { FIELDS, patchLimits } = await import('../../domain/js/fields.js')
const { STEPS, IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const { DEFAULT_PERSONAS, PRIMARY_PERSONA_AGENT, personaLabel } = await import('../src/personas.js')

const workItemColumns = new Set(db.prepare('PRAGMA table_info(work_item)').all().map((c) => c.name))

test('sanity: the real work_item schema was read, not an empty result', () => {
  assert.ok(workItemColumns.size > 10, `PRAGMA table_info returned ${workItemColumns.size} column(s)`)
  assert.ok(workItemColumns.has('id'))
  assert.ok(FIELDS.length >= 4, 'the field table is implausibly small')
})

test('every column domain/fields.json declares is a real work_item column', () => {
  for (const field of FIELDS) {
    assert.ok(
      workItemColumns.has(field.column),
      `domain/fields.json declares column "${field.column}" (field "${field.name}"), which work_item does not have — a patch to it would be a SQL error at run time`,
    )
  }
})

test('a patch naming every derived column really does UPDATE, end to end', () => {
  // The strongest form of the check above: not "the column exists" but "the
  // statement completeFarmRun builds actually runs".
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('FC-1', 'Fixture', 'Medium', 0)").run()
  const columns = FIELDS.map((f) => f.column)
  db.prepare(
    `UPDATE work_item SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
  ).run(...columns.map((c) => `value for ${c}`), 'FC-1')
  const row = db.prepare("SELECT * FROM work_item WHERE id = 'FC-1'").get()
  for (const column of columns) assert.equal(row[column], `value for ${column}`)
})

// ---- PATCH_FIELD_LABELS cannot silently drop a patchable field ----

test('stepCommentBody renders every agent-patchable field — none is written but unreported', () => {
  const columns = Object.keys(patchLimits())
  assert.ok(columns.length >= 3, `only ${columns.length} patchable field(s) — this check would be near-vacuous`)

  const item = { id: 'FC-1', repo: 'Org/repo', issue: 1 }
  const patch = Object.fromEntries(columns.map((c) => [c, `new ${c} value`]))
  const body = orchestrator.stepCommentBody(item, IMPLEMENT_STEP_INDEX, 1, 'did the step', patch, false, null)

  assert.match(body, /\*\*Updated fields:\*\*/, 'the patch section did not render at all')
  for (const column of columns) {
    assert.ok(
      body.includes(`new ${column} value`),
      `patchable field "${column}" is written to work_item but missing from the GitHub comment — it has no entry in PATCH_FIELD_LABELS`,
    )
  }
  // Every column is prose now that `persona` has left the derived list (HZ-125):
  // the routing tag travels as a `personas` MAP outside patchLimits(), so it
  // would slip past the loop above. It has the same silent-drop failure mode, so
  // it gets the same end-to-end check — rendered through personaLabel(), which is
  // the point of it having its own branch in stepCommentBody.
  const agent = PRIMARY_PERSONA_AGENT
  const persona = DEFAULT_PERSONAS[agent]
  const withPersonas = orchestrator.stepCommentBody(
    item,
    IMPLEMENT_STEP_INDEX,
    1,
    'did the step',
    { personas: { [agent]: persona } },
    false,
    null,
  )
  assert.ok(
    withPersonas.includes(personaLabel(agent, persona)),
    'a `personas` patch is written to work_item but missing from the GitHub comment',
  )
  assert.ok(!withPersonas.includes(`${agent} — ${persona}`), 'the raw persona id rendered instead of its label')
  // Positive control: the filter that drops unlabelled keys is still in place, so
  // the loop above is not passing because everything renders unconditionally.
  const withStray = orchestrator.stepCommentBody(item, IMPLEMENT_STEP_INDEX, 1, 'did it', { not_a_field: 'x' }, false, null)
  assert.ok(!withStray.includes('not_a_field'), 'an unknown patch key rendered into the comment')
})

test('sanity: the step the comment is rendered for is an agent step', () => {
  assert.equal(STEPS[IMPLEMENT_STEP_INDEX].kind, 'agent')
})
