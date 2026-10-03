// HZ-270 metric 5: the caretaker's decisions follow farm/roles/caretaker.md.
//
// Every case runs the REAL role file through parsePolicy — no hand-built
// policy — so a test here fails when the file and the evaluators drift. The
// last few cases prove the file drives behaviour (a changed marker changes the
// decision) and that a broken file throws rather than deciding.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { requiredStepIndex } from '../../domain/js/lifecycle.js'
import { REPO_ROOT } from './helpers/repoFiles.mjs'
import { DECISIONS, EVALUATORS, decide, parsePolicy, redact } from '../src/caretakerRules.js'

const POLICY_TEXT = readFileSync(join(REPO_ROOT, 'farm/roles/caretaker.md'), 'utf8')
const policy = parsePolicy(POLICY_TEXT)
const fixture = (name) => readFileSync(join(REPO_ROOT, 'server/test/fixtures/caretaker', name), 'utf8')

const G5 = requiredStepIndex('Approve the high-level design')
const G10 = requiredStepIndex('Review before execution')
const G13 = requiredStepIndex('Accept the code')
const G15 = requiredStepIndex('Review the work & close')

const facts = (over = {}) => ({
  artifact: '',
  runningKinds: [],
  mergeable: null,
  review: null,
  releaseTag: null,
  lastGoodTag: null,
  ...over,
})

test('parity: every rule in the role file has an evaluator, and every evaluator a rule', () => {
  const fileIds = policy.rules.map((r) => r.id).sort()
  assert.deepEqual(fileIds, Object.keys(EVALUATORS).sort())
  for (const rule of policy.rules) assert.ok(Object.hasOwn(DECISIONS, rule.decision), rule.id)
})

// ---- gate 5 ----

test('g5.approve: HZ-270\'s own options artifact approves option A — its prose "Blocking finding" is not a blocker', () => {
  const result = decide(G5, facts({ artifact: fixture('hz270-options.md') }), policy)
  assert.equal(result.decision, 'approve')
  assert.equal(result.ruleId, 'g5.approve')
  assert.match(result.reason, /recommended option A/)
})

test('g5.blocker: an open bullet under ## Blockers sends back with a comment naming it', () => {
  const artifact = `${fixture('hz270-options.md')}\n## Blockers\n- \`event.item_id\` is NOT NULL, so no table can hold the project event\n`
  const result = decide(G5, facts({ artifact }), policy)
  assert.equal(result.decision, 'send_back')
  assert.equal(result.ruleId, 'g5.blocker')
  assert.match(result.reason, /open blocker: `event.item_id` is NOT NULL/)
  assert.match(result.comment, /event.item_id/)
})

test('g5.blocker: "None." and ticked bullets are not open blockers', () => {
  for (const blockers of ['None.', '- None', '- [x] resolved: table approved']) {
    const artifact = `${fixture('hz270-options.md')}\n## Blockers\n${blockers}\n`
    assert.equal(decide(G5, facts({ artifact }), policy).decision, 'approve', blockers)
  }
})

// ---- gate 10 ----

test('g10.send_back: SEND BACK carries every action in the PM\'s list, sub-bullets included', () => {
  const result = decide(G10, facts({ artifact: fixture('hz270-pm-summary.md') }), policy)
  assert.equal(result.decision, 'send_back')
  assert.equal(result.ruleId, 'g10.send_back')
  assert.match(result.reason, /SEND BACK; 3 action\(s\)/)
  assert.ok(!result.reason.includes('\n'), 'the reason must be one line')
  for (const action of [
    'pick a real gate 15 fact and write it into the plan.',
    'define a structured blocker marker in `farm/roles/caretaker.md`',
    'revise the plan as follows:',
    'Gate 13 reads structured output.',
    '`loadPolicy` uses `readFarmFile`.',
  ]) {
    assert.ok(result.comment.includes(action), `missing from the comment: ${action}`)
  }
  assert.ok(!result.comment.includes('HZ-245'), 'the ## Overlap section leaked into the comment')
})

for (const verdict of ['PROCEED', 'PROCEED WITH CONDITIONS']) {
  test(`g10.approve: **${verdict}** approves`, () => {
    const artifact = `## Recommendation\n**${verdict}** — the plan is sound.\n## Actions\nNone.\n`
    const result = decide(G10, facts({ artifact }), policy)
    assert.equal(result.decision, 'approve')
    assert.equal(result.ruleId, 'g10.approve')
    assert.equal(result.reason, `PM said ${verdict}`)
  })
}

// ---- gate 13 ----

const G13_MATRIX = [
  ['review pass, merges cleanly', { review: 'pass', mergeable: 1 }, 'approve', 'g13.approve'],
  ['does not merge cleanly', { review: 'pass', mergeable: 0 }, 'resolve_conflicts', 'g13.conflicts'],
  ['a resolve run in progress', { review: 'pass', mergeable: 0, runningKinds: ['resolve'] }, 'wait', 'g13.wait'],
  ['a premerge run in progress', { review: 'pass', mergeable: 1, runningKinds: ['premerge'] }, 'wait', 'g13.wait'],
  ['review failed (forwarded)', { review: 'fail', mergeable: 1 }, 'ping_human', null],
  ['mergeability unknown', { review: 'pass', mergeable: null }, 'ping_human', null],
]
for (const [name, over, decision, ruleId] of G13_MATRIX) {
  test(`gate 13: ${name} -> ${decision}`, () => {
    const result = decide(G13, facts(over), policy)
    assert.equal(result.decision, decision)
    assert.equal(result.ruleId, ruleId)
  })
}

// ---- gate 15 ----

test('g15.approve: the release tag equals the target\'s last-good tag', () => {
  const result = decide(G15, facts({ releaseTag: 'v2026.10.02-1', lastGoodTag: 'v2026.10.02-1' }), policy)
  assert.equal(result.decision, 'approve')
  assert.equal(result.ruleId, 'g15.approve')
})

for (const [name, over] of [
  ['a different last-good tag (deploy failed health)', { releaseTag: 'v2026.10.02-1', lastGoodTag: 'v2026.10.01-3' }],
  ['no last-good tag on record', { releaseTag: 'v2026.10.02-1', lastGoodTag: null }],
  ['no release published', { releaseTag: null, lastGoodTag: null }],
]) {
  test(`g15.ping: ${name} pings the human`, () => {
    const artifact = 'published release v2026.10.02-1 — the self-deploy webhook will pull it to shoreward.ai'
    const result = decide(G15, facts({ artifact, ...over }), policy)
    assert.equal(result.decision, 'ping_human')
    assert.equal(result.ruleId, 'g15.ping')
  })
}

// ---- precedence: "operator must decide" beats every approve ----

test('precedence: an operator-decide line beats approve at gate 5 and gate 10, with "ruling needed"', () => {
  const g5 = `${fixture('hz270-options.md')}\n- **Operator must decide:** whether project_event is acceptable\n`
  const r5 = decide(G5, facts({ artifact: g5 }), policy)
  assert.equal(r5.decision, 'ping_human')
  assert.equal(r5.ruleId, 'any.operator_decide')
  assert.match(r5.reason, /^ruling needed: whether project_event is acceptable/)

  const g10 = '## Recommendation\n**PROCEED** — fine.\nOperator must decide: the gate 15 fact\n'
  const r10 = decide(G10, facts({ artifact: g10 }), policy)
  assert.equal(r10.decision, 'ping_human')
  assert.match(r10.reason, /ruling needed/)
})

test('precedence: a phrase merely quoting `operator must decide` is not a ruling request', () => {
  // HZ-270's own PM summary quotes the phrase in its test contract.
  assert.equal(decide(G10, facts({ artifact: fixture('hz270-pm-summary.md') }), policy).decision, 'send_back')
})

test('precedence: a running pre-merge beats resolve conflicts at gate 13', () => {
  const result = decide(G13, facts({ mergeable: 0, runningKinds: ['premerge'] }), policy)
  assert.equal(result.decision, 'wait')
})

// ---- the file drives behaviour ----

test('policy mutation: changing a marker in the file changes the decision, and the old marker stops working', () => {
  const mutated = parsePolicy(POLICY_TEXT.replace('"## Blockers"', '"## Stop signs"'))
  const oldMarker = `${fixture('hz270-options.md')}\n## Blockers\n- something\n`
  const newMarker = `${fixture('hz270-options.md')}\n## Stop signs\n- something\n`
  assert.equal(decide(G5, facts({ artifact: oldMarker }), mutated).decision, 'approve')
  assert.equal(decide(G5, facts({ artifact: newMarker }), mutated).decision, 'send_back')
  // And the real file is the other way round.
  assert.equal(decide(G5, facts({ artifact: oldMarker }), policy).decision, 'send_back')
  assert.equal(decide(G5, facts({ artifact: newMarker }), policy).decision, 'approve')
})

test('policy mutation: dropping a rule from the file removes the behaviour', () => {
  const text = POLICY_TEXT.replace(/\s*\{ "id": "g13\.conflicts"[^\n]*\n/, '\n')
  assert.throws(() => parsePolicy(POLICY_TEXT.replace('"g13.conflicts"', '"g13.nope"')), /no evaluator/)
  const trimmed = parsePolicy(text)
  assert.equal(decide(G13, facts({ mergeable: 0 }), trimmed).decision, 'ping_human')
})

test('a broken policy throws instead of deciding', () => {
  assert.throws(() => parsePolicy('no block here'), /no caretaker-rules block/)
  assert.throws(() => parsePolicy('```caretaker-rules\n{bad json\n```'))
  assert.throws(() => parsePolicy('```caretaker-rules\n{"rules":[{"id":"g15.ping","gate":"No such step","decision":"ping_human"}]}\n```'))
})

test('redact strips token values and caps to one line', () => {
  process.env.GITHUB_TOKEN = 'tok123'
  try {
    assert.equal(redact('a\nb tok123 c'), 'a b [redacted] c')
    assert.equal(redact('x'.repeat(500)).length, 200)
  } finally {
    delete process.env.GITHUB_TOKEN
  }
})

// ---- gate 5: recommendation phrasing (HZ-299) ----

const ENSEMBLE_TEXT = readFileSync(join(REPO_ROOT, 'farm/roles/ensemble.md'), 'utf8')
const g5 = (recommendation, blockers = 'None.') =>
  `## Options\n\n### A — one\n### B — two\n### C — three\n\n## Recommendation\n\n${recommendation}\n\n## Blockers\n\n${blockers}\n`
const g5Decide = (recommendation, blockers, p = policy) => decide(G5, facts({ artifact: g5(recommendation, blockers) }), p)

test('ensemble role: the Recommendation ends with the fixed `Recommended option: <letter>` line, headings in order', () => {
  assert.match(ENSEMBLE_TEXT, /End '## Recommendation' with one final line, exactly `Recommended option: <letter>`/)
  const rec = ENSEMBLE_TEXT.indexOf("'## Recommendation' with rationale")
  assert.ok(rec !== -1 && rec < ENSEMBLE_TEXT.indexOf("then '## Blockers'"))
})

const G5_PHRASES = [
  ['Recommended option: A', 'A'],
  ['Approve Option A', 'A'],
  ['**Approve Option A.**', 'A'],
  ['Recommended: A', 'A'],
  ['Option A is recommended', 'A'],
  ['choose A', 'A'],
  ['recommend Option B', 'B'],
  ['go with option C', 'C'],
  ['- Recommended option: A', 'A'],
  ['* Recommended option: A', 'A'],
  ['> Recommended option: A', 'A'],
  ['1. Recommended option: A', 'A'],
]
test('g5.approve: each phrase approves with its option letter, twice against one parsed policy', () => {
  for (let round = 0; round < 2; round++) {
    for (const [text, letter] of G5_PHRASES) {
      const result = g5Decide(`Some rationale here.\n\n${text}`)
      assert.equal(result.decision, 'approve', `${text} (round ${round})`)
      assert.equal(result.ruleId, 'g5.approve', text)
      assert.equal(result.reason, `recommended option ${letter}`, text)
    }
  }
})

test('g5.approve: a Recommendation naming no option pings the human', () => {
  const result = g5Decide('All options look viable.')
  assert.equal(result.decision, 'ping_human')
  assert.equal(result.ruleId, null)
})

for (const name of ['hz296-options.md', 'us193-options.md', 'hz299-options.md']) {
  test(`g5.approve: ${name} (real options text, Blockers: None) approves option A`, () => {
    const result = decide(G5, facts({ artifact: fixture(name) }), policy)
    assert.equal(result.decision, 'approve')
    assert.equal(result.ruleId, 'g5.approve')
    assert.equal(result.reason, 'recommended option A')
  })
}

test('g5.blocker: Blockers "None", "None." or empty is not open; HZ-296 text still approves', () => {
  const body = fixture('hz296-options.md').replace(/## Blockers[\s\S]*$/, '')
  for (const blockers of ['None', 'None.', '']) {
    const result = decide(G5, facts({ artifact: `${body}## Blockers\n\n${blockers}\n` }), policy)
    assert.equal(result.decision, 'approve', JSON.stringify(blockers))
    assert.equal(result.reason, 'recommended option A')
  }
})

test('g5.blocker: a real Blockers bullet sends back even when the Recommendation names an option', () => {
  const result = g5Decide('Recommended option: A', '- `GMAIL_REFRESH_TOKEN` is not provisioned')
  assert.equal(result.decision, 'send_back')
  assert.equal(result.ruleId, 'g5.blocker')
})

for (const text of [
  'Option A is not recommended',
  'do not choose A',
  'don’t choose A',
  "don't choose A",
  'reject Option B',
]) {
  test(`g5.approve: negated phrasing "${text}" pings the human`, () => {
    assert.equal(g5Decide(text).decision, 'ping_human')
  })
}

for (const [name, text] of [
  ['the canonical line plus "go with B"', 'We could go with B.\n\nRecommended option: A'],
  ['an unclosed quote before a second option on a new line', "Approve Option A. The 'fast path idea\ngo with B"],
]) {
  test(`g5.approve: two different options (${name}) pings the human`, () => {
    assert.equal(g5Decide(text).decision, 'ping_human')
  })
}

test('g5.approve: an option phrase outside ## Recommendation does not approve', () => {
  const artifact = '## Options\n\nchoose A\n\n## Recommendation\n\nAll options look viable.\n\n## Blockers\n\nNone.\n'
  assert.equal(decide(G5, facts({ artifact }), policy).decision, 'ping_human')
})

test('g5.approve: a quoted example is not a recommendation', () => {
  assert.equal(g5Decide("If the prose says 'go with B', that pings.\n\nRecommended option: A").reason, 'recommended option A')
})

test('policy mutation: dropping a negation from the file lets that negated phrase approve', () => {
  const mutated = parsePolicy(POLICY_TEXT.replace('"\\\\bnot\\\\b", ', ''))
  assert.equal(g5Decide('do not choose A', 'None.', mutated).decision, 'approve')
  assert.equal(g5Decide('do not choose A').decision, 'ping_human')
})

test('HZ-299 changed only g5.approve: every other rule parses as before', () => {
  const others = policy.rules.filter((r) => r.id !== 'g5.approve')
  assert.deepEqual(
    others.map(({ gateIndex, ...r }) => r),
    [
      { id: 'any.operator_decide', gate: 'any', decision: 'ping_human', linePrefix: 'operator must decide:' },
      { id: 'g5.blocker', gate: 'Approve the high-level design', decision: 'send_back', section: '## Blockers' },
      { id: 'g10.send_back', gate: 'Review before execution', decision: 'send_back', section: '## Recommendation',
        markers: ['**SEND BACK**'], commentSection: '## Actions' },
      { id: 'g10.approve', gate: 'Review before execution', decision: 'approve', section: '## Recommendation',
        markers: ['**PROCEED WITH CONDITIONS**', '**PROCEED**'] },
      { id: 'g13.wait', gate: 'Accept the code', decision: 'wait', kinds: ['premerge', 'resolve'] },
      { id: 'g13.conflicts', gate: 'Accept the code', decision: 'resolve_conflicts', mergeable: 0 },
      { id: 'g13.approve', gate: 'Accept the code', decision: 'approve', review: 'pass', mergeable: 1 },
      { id: 'g15.approve', gate: 'Review the work & close', decision: 'approve' },
      { id: 'g15.ping', gate: 'Review the work & close', decision: 'ping_human' },
    ],
  )
})
