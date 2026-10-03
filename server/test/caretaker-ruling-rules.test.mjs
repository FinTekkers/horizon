// HZ-273: the caretaker's ruling checks, pure. Every case here runs
// validateRuling() or spliceIssueBody() directly — no DB, no network. The
// end-to-end proof that a rejected ruling writes nothing is
// caretaker-ruling.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// store.parseIssueBody is the sync's own parser; importing store opens a DB.
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-ruling-rules-')), 'test.db')

const { validateRuling, spliceIssueBody, isSecurityLine, CLARIFY_GROWTH_MAX } = await import('../src/caretakerRulingRules.js')
const { FIELDS, fieldByName } = await import('../../domain/js/fields.js')
const { parseIssueBody } = await import('../src/store.js')

const METRIC = ['1. The export runs in under a minute.', '2. Every row is reconciled against the ledger…'].join('\n')
const GUARDRAILS = ['- Never write to the ledger.', '- Keep the CSV format stable.', '- Read only from the replica.'].join('\n')
const current = { metric: METRIC, guardrails: GUARDRAILS }
const ruling = (kind, field, before, after, extra = {}) => ({ kind, reason: 'settles the question', edits: [{ field, before, after }], ...extra })
const noEnv = {}

// ---- metric 2: the allowed kinds are applied ----

test('narrow, clarify and restore are each accepted, and only the named line changes', () => {
  const cases = [
    ruling('narrow', 'guardrails', '- Read only from the replica.', '- Read only from the EU replica.'),
    ruling('clarify', 'guardrails', '- Keep the CSV format stable.', '- Keep the CSV column order and headers stable.'),
    ruling('restore', 'metric', '2. Every row is reconciled against the ledger…', '2. Every row is reconciled against the ledger before export.'),
  ]
  for (const proposal of cases) {
    const verdict = validateRuling(proposal, current, FIELDS, noEnv)
    assert.equal(verdict.ok, true, `${proposal.kind}: ${verdict.code} ${verdict.detail}`)
    const { field, before, after } = proposal.edits[0]
    const other = field === 'metric' ? 'guardrails' : 'metric'
    assert.equal(verdict.next[other], current[other], `${proposal.kind} left ${other} alone`)
    assert.equal(verdict.next[field], current[field].replace(before, after))
    assert.deepEqual(verdict.edits, [{ field, before, after }])
  }
})

// ---- metric 2: new lines, new scope, defer ----

test('a ruling that adds a line, names no existing line, grows a line too far, or defers is rejected', () => {
  const longer = `- Keep the CSV format stable.${'!'.repeat(CLARIFY_GROWTH_MAX + 1)}`
  const cases = [
    [ruling('clarify', 'metric', '1. The export runs in under a minute.', '1. The export runs in under a minute.\n3. It also emails a PDF.'), 'adds_lines'],
    [ruling('narrow', 'metric', '3. A brand-new metric line.', '3. A narrower brand-new metric line.'), 'before_not_found'],
    [ruling('clarify', 'guardrails', '- Keep the CSV format stable.', longer), 'too_long_for_clarify'],
    [ruling('defer', 'metric', '1. The export runs in under a minute.', '1. Deferred to a follow-up item: HZ-999'), 'defer_not_enabled'],
    [ruling('widen', 'metric', '1. The export runs in under a minute.', '1. The export runs.'), 'bad_kind'],
    [{ unsure: true, reason: 'not sure' }, 'unsure'],
    [ruling('clarify', 'guardrails', '- Keep the CSV format stable.', '* Keep the CSV format stable, byte for byte.'), 'marker_changed'],
  ]
  for (const [proposal, code] of cases) {
    const verdict = validateRuling(proposal, current, FIELDS, noEnv)
    assert.equal(verdict.ok, false, code)
    assert.equal(verdict.code, code)
    assert.equal(verdict.next, undefined, `${code}: nothing to write`)
  }
})

// ---- metric 3: no deleted guardrail, no softened security rule ----

test('a guardrail line that becomes empty or marker-only is rejected', () => {
  for (const after of ['', '   ', '- ', '-']) {
    const verdict = validateRuling(ruling('narrow', 'guardrails', '- Keep the CSV format stable.', after), current, FIELDS, noEnv)
    assert.equal(verdict.code, 'removes_guardrail', JSON.stringify(after))
  }
})

test('dropping never/must from a line about auth, secrets, sudoers or the PIN is rejected; so is any edit that touches one', () => {
  const security = [
    ['- Never bypass auth on the gate routes.', '- Avoid bypassing auth on the gate routes.'],
    ['- Secrets must stay in environment variables.', '- Secrets should stay in environment variables.'],
    ['- Never widen infra/host/horizon-deploy.sudoers.', '- Avoid widening infra/host/horizon-deploy.sudoers.'],
    ['- The PIN must never be logged.', '- The PIN should not be logged.'],
  ]
  const guardrails = [...security.map(([before]) => before), '- Keep the CSV format stable.'].join('\n')
  for (const [before, after] of security) {
    const verdict = validateRuling(ruling('clarify', 'guardrails', before, after), { metric: METRIC, guardrails }, FIELDS, noEnv)
    assert.equal(verdict.ok, false, before)
    assert.equal(verdict.code, 'weakens_rule', before)
  }
  // Fail closed: keeping every modal is still not enough on a security line,
  // and a neutral line may not gain auth or PIN wording.
  const failClosed = [
    ruling('clarify', 'guardrails', '- Never widen infra/host/horizon-deploy.sudoers.', '- Never widen infra/host/horizon-deploy.sudoers in any way.'),
    ruling('restore', 'guardrails', '- The PIN must never be logged.', '- The PIN must never be logged or shown.'),
    ruling('clarify', 'guardrails', '- Keep the CSV format stable.', '- Keep the CSV format stable; auth may change.'),
    ruling('clarify', 'guardrails', '- Keep the CSV format stable.', '- Keep the CSV format stable and print the PIN.'),
  ]
  for (const proposal of failClosed) {
    const verdict = validateRuling(proposal, { metric: METRIC, guardrails }, FIELDS, noEnv)
    assert.equal(verdict.code, 'security_line', proposal.edits[0].after)
  }
  assert.ok(isSecurityLine('a token value') && isSecurityLine('OAuth login') && !isSecurityLine('keep the CSV stable'))
})

test('a restore must extend the cut text, not rewrite it', () => {
  const verdict = validateRuling(
    ruling('restore', 'metric', '2. Every row is reconciled against the ledger…', '2. Most rows are checked.'),
    current,
    FIELDS,
    noEnv,
  )
  assert.equal(verdict.code, 'not_a_restore')
})

// ---- metric 4: the field budget, from domain/fields.json ----

test('a result 1 character over the budget is rejected with nothing to write; exactly at the budget is accepted', () => {
  const { maxLength } = fieldByName('guardrails')
  const tail = '- Keep the CSV format stable.'
  // The field ends up exactly maxLength (+1) long once "stable." becomes "stable, always."
  const growth = '- Keep the CSV format stable, always.'.length - tail.length
  for (const [extra, ok] of [
    [0, true],
    [1, false],
  ]) {
    const filler = `- ${'x'.repeat(maxLength - tail.length - growth - 3 + extra)}`
    const guardrails = `${filler}\n${tail}`
    assert.equal(guardrails.length + growth, maxLength + extra)
    const verdict = validateRuling(ruling('clarify', 'guardrails', tail, '- Keep the CSV format stable, always.'), { metric: METRIC, guardrails }, FIELDS, noEnv)
    assert.equal(verdict.ok, ok, `${extra} over`)
    if (ok) assert.equal(verdict.next.guardrails.length, maxLength)
    else {
      assert.equal(verdict.code, 'over_budget')
      assert.equal(verdict.next, undefined, 'never truncated, never returned')
    }
  }
})

test('the budget is read from the field table handed in, not a literal', () => {
  const proposal = ruling('clarify', 'guardrails', '- Keep the CSV format stable.', '- Keep the CSV format stable, always.')
  assert.equal(validateRuling(proposal, current, FIELDS, noEnv).ok, true)
  const tight = FIELDS.map((f) => (f.name === 'guardrails' ? { ...f, maxLength: GUARDRAILS.length } : f))
  assert.equal(validateRuling(proposal, current, tight, noEnv).code, 'over_budget')
})

// ---- guardrail: no tokens in what gets written ----

test('an after carrying a GitHub token or a secret env value is rejected as secret_in_text', () => {
  const token = `ghp_${'a'.repeat(36)}`
  const withToken = ruling('clarify', 'guardrails', '- Keep the CSV format stable.', `- Keep the CSV format stable (${token}).`)
  assert.equal(validateRuling(withToken, current, FIELDS, noEnv).code, 'secret_in_text')
  const withEnv = ruling('clarify', 'guardrails', '- Keep the CSV format stable.', '- Keep the CSV format stable s3cr3t-value.')
  assert.equal(validateRuling(withEnv, current, FIELDS, { GITHUB_WEBHOOK_SECRET: 's3cr3t-value' }).code, 'secret_in_text')
})

// ---- metric 1: the splice changes only the named line, byte for byte ----

test('spliceIssueBody changes only the line inside its own section — CRLF, trailing spaces and a twin line in the description kept', () => {
  const lines = [
    '## Outcome',
    'Export the ledger.',
    '- Keep the CSV format stable.   ',
    '',
    '## Success metric',
    '1. The export runs in under a minute.',
    '',
    '## Guardrails',
    '- Never write to the ledger.',
    '- Keep the CSV format stable.   ',
    '- Read only from the replica.',
  ]
  const body = lines.join('\r\n')
  const edit = { field: 'guardrails', before: '- Keep the CSV format stable.', after: '- Keep the CSV column order stable.' }
  const spliced = spliceIssueBody(body, [edit])
  assert.equal(spliced.ok, true)
  const out = spliced.body.split('\n')
  const raw = body.split('\n')
  assert.equal(out.length, raw.length)
  for (let i = 0; i < raw.length; i++) {
    if (i === 9) assert.equal(out[i], '- Keep the CSV column order stable.\r', 'the target line keeps its CRLF ending')
    else assert.equal(out[i], raw[i], `line ${i} is byte-identical`)
  }
  // What the sync will read back is exactly what the validator computed.
  const parsed = parseIssueBody(body)
  const verdict = validateRuling({ kind: 'clarify', reason: 'r', edits: [edit] }, parsed, FIELDS, noEnv)
  assert.equal(parseIssueBody(spliced.body).guardrails, verdict.next.guardrails)
  assert.equal(parseIssueBody(spliced.body).desc, parsed.desc)
})

test('spliceIssueBody fails closed when the line is gone or the section repeats', () => {
  const body = '## Success metric\n1. x\n\n## Guardrails\n- a\n'
  assert.equal(spliceIssueBody(body, [{ field: 'guardrails', before: '- b', after: '- c' }]).code, 'stale_body')
  assert.equal(spliceIssueBody(`${body}\n## Guardrails\n- a\n`, [{ field: 'guardrails', before: '- a', after: '- c' }]).code, 'stale_body')
  assert.equal(spliceIssueBody('no sections at all', [{ field: 'metric', before: '1. x', after: '1. y' }]).code, 'stale_body')
})
