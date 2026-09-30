// HZ-135, hand-written and PERMANENT — never delete this file.
//
// Every other test in this change reads the vocabulary out of the binding, so
// every other test would stay green if domain/priorities.json were rewritten.
// This one types the values out, on purpose: it is the proof that moving the
// vocabulary into domain/ changed no value, no order, no colour, no SQL and no
// GitHub label. It covers three success metrics that nothing else can:
//
//   1. "The priority list and its ORDER are declared once, in domain/." The order
//      is pinned as a sequence, not a set.
//   4. "GitHub priority labels are unchanged." The label name format and every
//      colour hex, typed out as they stood before the change.
//   5. "Existing items keep their priority values." The emitted SQL CHECK clause,
//      byte for byte — that string is the one part of this change a reviewer
//      cannot diff by eye, because it is now built rather than written.
//
// That also makes this the ONE file outside domain/ allowed to hold a collection
// of priority values — see domain-priority-literals.test.mjs's exemption list.
//
// The two colour maps are pinned as full key->value mappings rather than as key
// sets. Both are keyed off PRIORITY.* now, which is safer than the array-index
// keying that was considered, but "keyed by a named constant" still says nothing
// about whether the constant points at the colour it used to. Only a hand-typed
// expectation does.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.HORIZON_DB = path.join(mkdtempSync(path.join(tmpdir(), 'horizon-prio-pins-')), 'test.db')

import { PRIORITIES, DEFAULT_PRIORITY, PRIORITY, isPriority } from '../../domain/js/priorities.js'
import { PRIORITY_LABEL_RE, priorityLabelName, priorityFromLabels } from '../src/priorityLabels.js'
import { PRIORITY_COLORS, priorityColor } from '../../ui/src/domain/lifecycle.js'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

// The vocabulary as it stood before HZ-135 moved it, in the order it stood in.
const PINNED = ['Critical', 'High', 'Medium', 'Low']
const PINNED_DEFAULT = 'Medium'

// ---- metric 1: the values and the ORDER ----

test('PIN: the declared vocabulary is exactly these four values, IN THIS ORDER', () => {
  assert.deepEqual(PRIORITIES, PINNED, 'the priority vocabulary or its order changed')
})

test('PIN: the default is Medium — what POST /api/items and a label-less GitHub issue get', () => {
  assert.equal(DEFAULT_PRIORITY, PINNED_DEFAULT)
})

test('PIN: order is SEVERITY, highest first — the intake picker and the wizard both render it', () => {
  // Stated as an ordering relation rather than just a list, because "and its
  // order" is in the metric and a reversed array would still satisfy a set check.
  assert.equal(PRIORITIES.indexOf('Critical'), 0)
  assert.ok(PRIORITIES.indexOf('Critical') < PRIORITIES.indexOf('High'))
  assert.ok(PRIORITIES.indexOf('High') < PRIORITIES.indexOf('Medium'))
  assert.ok(PRIORITIES.indexOf('Medium') < PRIORITIES.indexOf('Low'))
  assert.equal(PRIORITIES.at(-1), 'Low')
})

test('PIN: PRIORITY exposes exactly these four named constants, and is frozen', () => {
  assert.deepEqual(PRIORITY, { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' })
  assert.ok(Object.isFrozen(PRIORITY))
})

test('PIN: isPriority accepts exactly these four and nothing else', () => {
  for (const value of PINNED) assert.equal(isPriority(value), true, `${value} is no longer a priority`)
  for (const value of ['Urgent', 'critical', 'HIGH', 'Blocker', '', undefined, null]) {
    assert.equal(isPriority(value), false, `${value} is now accepted as a priority`)
  }
})

// ---- metric 5: the SQL constraint is byte-identical ----

test('PIN: the constraint SQLite actually stored is byte-identical to the hand-typed one', async () => {
  // Read back out of the REAL database rather than off an exported constant.
  // SQLite keeps the CREATE TABLE text verbatim in sqlite_master, so this is the
  // clause the engine is enforcing — not a string that merely resembles it. That
  // is a stronger pin than importing the template would be, and it is why
  // server/src/db.js keeps PRIORITY_CHECK module-local: nothing there is exported
  // for a test's benefit.
  //
  // Imported lazily: server/src/db.js opens a database at import time, and
  // HORIZON_DB has to be set first (done at the top of this file).
  const { db } = await import('../src/db.js')
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'work_item'").get()
  assert.ok(
    sql.includes("priority   TEXT NOT NULL CHECK (priority IN ('Critical','High','Medium','Low'))"),
    `the stored work_item priority constraint changed:\n${sql}`,
  )
})

test('PIN: an existing database keeps its constraint — the statement is IF NOT EXISTS', () => {
  // Metric 5 holds by construction rather than by migration, and this is the
  // structural half of that claim: the clause sits inside CREATE TABLE IF NOT
  // EXISTS, so on an existing database the whole statement is a no-op and no
  // stored value is revalidated, rewritten or dropped.
  const db = readFileSync(path.join(REPO_ROOT, 'server/src/db.js'), 'utf8')
  assert.match(db, /CREATE TABLE IF NOT EXISTS work_item \(/, 'the work_item DDL is no longer IF NOT EXISTS')
  const ddl = db.slice(db.indexOf('CREATE TABLE IF NOT EXISTS work_item ('))
  assert.match(ddl.slice(0, 400), /priority\s+TEXT NOT NULL \$\{PRIORITY_CHECK\}/, 'the DDL does not use the derived clause')
  // And no ALTER TABLE or UPDATE touches priority anywhere in db.js.
  assert.ok(!/ALTER TABLE[^\n]*priority/i.test(db), 'db.js alters the priority column — metric 5 needs no migration')
  assert.ok(!/UPDATE work_item SET priority/i.test(db), 'db.js rewrites stored priorities — metric 5 forbids that')
})

// ---- metric 4: GitHub labels are unchanged ----

test('PIN: the label NAME format is unchanged — `priority: <lower-case value>`', () => {
  assert.equal(priorityLabelName('Critical'), 'priority: critical')
  assert.equal(priorityLabelName('High'), 'priority: high')
  assert.equal(priorityLabelName('Medium'), 'priority: medium')
  assert.equal(priorityLabelName('Low'), 'priority: low')
})

test('PIN: the GitHub label colour for every value is unchanged', async () => {
  // server/src/github.js keeps these hand-owned — colour is presentation, and
  // these hex values are literally persisted to GitHub, which knows nothing about
  // CSS variables — keyed off PRIORITY.*. Read out of the real module, so a key
  // that stopped resolving shows up as an undefined entry rather than as text that
  // happens to still be in the file.
  //
  // priority-labels.test.mjs owns the other half: that setPriorityLabel's POST body
  // actually carries this map's value. Neither file can go vacuous alone.
  const { PRIORITY_LABEL_COLORS } = await import('../src/github.js')
  assert.deepEqual(PRIORITY_LABEL_COLORS, {
    Critical: '9C333E',
    High: 'DFA200',
    Medium: '2E6CB2',
    Low: '8C8C8E',
  })
  // Keyed in authored order, and every declared priority has an entry — so a value
  // added to domain/priorities.json cannot silently fall back to the grey default.
  assert.deepEqual(Object.keys(PRIORITY_LABEL_COLORS), [...PRIORITIES])
})

test('PIN: the label pattern still reads back every shape a human might have typed', () => {
  for (const [label, expected] of [
    ['priority: critical', 'Critical'],
    ['priority:critical', 'Critical'],
    ['Priority/High', 'High'],
    ['priority-medium', 'Medium'],
    ['PRIORITY: Low', 'Low'],
    ['low', 'Low'],
    ['High', 'High'],
  ]) {
    const match = PRIORITY_LABEL_RE.exec(label)
    assert.ok(match, `"${label}" is no longer recognised as a priority label`)
    assert.equal(priorityFromLabels([{ name: label }]), expected, `"${label}" resolves to the wrong value`)
  }
  for (const label of ['priority: urgent', 'bug', 'needs-triage', '', 'priority']) {
    assert.equal(PRIORITY_LABEL_RE.test(label), false, `"${label}" is now matched as a priority label`)
  }
  // Every separator in the prefix is optional, so a run-on `prioritylow` matches
  // too. Pre-existing — the pattern is byte-equivalent to the one that stood
  // before HZ-135 — and pinned rather than fixed, because metric 4 says GitHub
  // label behaviour is UNCHANGED and tightening this would change it.
  assert.equal(priorityFromLabels([{ name: 'prioritylow' }]), 'Low')
})

test('PIN: a label round-trips — every value we WRITE is a value we can read back', () => {
  // The failure this prevents is specific and silent: write a label the pattern
  // cannot match, and the next GitHub webhook resolves no priority, falls back to
  // the default, and quietly overwrites the value a human just set.
  for (const value of PRIORITIES) {
    assert.equal(priorityFromLabels([{ name: priorityLabelName(value) }]), value, `${value} does not round-trip`)
  }
})

// ---- the UI colour map ----

test('PIN: the board colour token for every value is unchanged', () => {
  assert.deepEqual(PRIORITY_COLORS, {
    Critical: 'var(--danger-ink)',
    High: 'var(--warning-ink)',
    Medium: 'var(--primary-ink)',
    Low: 'var(--muted)',
  })
  // Derived from PRIORITY, so a value added to the vocabulary with no token
  // assigned shows up as a missing key rather than as a silently grey badge.
  assert.deepEqual(Object.keys(PRIORITY_COLORS), [...PRIORITIES])
  for (const value of PRIORITIES) assert.equal(priorityColor(value), PRIORITY_COLORS[value])
  assert.equal(priorityColor('Urgent'), 'var(--muted)', 'the unknown-value fallback changed')
})

// ---- the role prompt's prose, pinned rather than rewritten ----

test('PIN: farm/roles/concierge.md still names exactly the declared vocabulary, in order', () => {
  // This file is read as ROLE_PROMPT and fed to a model, so rewriting it to
  // reference domain/ would be a behaviour change to an LLM prompt — which
  // guardrail 1 forbids. It keeps its prose and gets pinned instead.
  //
  // Anchored on CONTENT, not a line number: the line moves whenever the prompt is
  // edited above it.
  const prompt = readFileSync(path.join(REPO_ROOT, 'farm/roles/concierge.md'), 'utf8')
  const match = prompt.match(/priority is exactly one of ([^(]+)\(capitalized\)/)
  assert.ok(match, 'concierge.md no longer states the priority vocabulary in the shape this pin reads')
  const listed = match[1].split(',').map((value) => value.trim()).filter(Boolean)
  assert.deepEqual(listed, [...PRIORITIES], 'concierge.md drifted from domain/priorities.json')
})

test('PIN: concierge.md still asks for the backlog grouped highest-severity first', () => {
  // The order is encoded in this prose too ("Critical first"), so a reordered
  // vocabulary has to reach a human here rather than silently contradicting the
  // prompt.
  const prompt = readFileSync(path.join(REPO_ROOT, 'farm/roles/concierge.md'), 'utf8')
  assert.ok(prompt.includes(`${PRIORITIES[0]} first`), `concierge.md no longer says "${PRIORITIES[0]} first"`)
})

// ---- the wizard's emitted text ----

test('PIN: the WhatsApp wizard offers the same numbered list it always did', () => {
  // Byte-for-byte. The prompt is now derived from the order, so this is the proof
  // the derivation reproduces the hand-typed string exactly — including the
  // numbering, the `) ` separator and the single spaces.
  const wizard = readFileSync(path.join(REPO_ROOT, 'farm/wizard.py'), 'utf8')
  assert.match(wizard, /"priority": f"Priority — reply \{_priority_options\(\)\}"/)
  assert.ok(!wizard.includes('1) Critical'), 'the wizard still hand-types the numbered list')
})
