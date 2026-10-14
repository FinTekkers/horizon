// HZ-448 metrics 1 and 2: a Plan's Draft output is checked against
// domain/planDraft.schema.json, and its dependencies must form a DAG. The
// shared cases in domain/fixtures/plan-draft-cases.json are run here through
// the JS binding and in farm/tests/test_plan_draft.py through the Python one,
// so both report the same first error. The last test runs the Python binding
// over the same cases from here too, so a drift fails this suite as well.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { PLAN_DRAFT_SCHEMA, validatePlanDraft, realKeysIn, renderPlanDraftMd } from '../../domain/js/planDraft.js'
import { fieldByName } from '../../domain/js/fields.js'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

const fixtures = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/fixtures/plan-draft-cases.json'), 'utf8'))
const schema = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/planDraft.schema.json'), 'utf8'))

function build(c) {
  const doc = structuredClone(fixtures.base)
  const walk = (dotted) => {
    const parts = dotted.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p))
    const last = parts.pop()
    return [parts.reduce((node, p) => node[p], doc), last]
  }
  for (const [dotted, value] of Object.entries(c.set || {})) {
    const [parent, key] = walk(dotted)
    parent[key] = structuredClone(value)
  }
  for (const dotted of c.drop || []) {
    const [parent, key] = walk(dotted)
    delete parent[key]
  }
  return doc
}

const { knownRepos, keyPrefixes, existingKeys } = fixtures.context
const serverContext = { knownRepos, keyPrefixes, keyExists: (key) => existingKeys.includes(key) }

for (const c of fixtures.cases) {
  test(`case: ${c.case}`, () => {
    const result = validatePlanDraft(build(c), serverContext)
    if (c.expect === null) {
      assert.deepEqual(result, { ok: true })
      return
    }
    assert.equal(result.ok, false)
    const [first] = result.errors
    assert.equal(first.code, c.expect.code, first.message)
    assert.ok(first.message.includes(c.expect.contains), `${first.message} does not name ${c.expect.contains}`)
    assert.ok(first.path, 'the error names no path')
    // Without the server's context, a server-only rule is not checked: the
    // farm's view, which the Python binding must match.
    const farmView = validatePlanDraft(build(c))
    if (c.serverOnly) assert.deepEqual(farmView, { ok: true })
    else assert.equal(farmView.errors[0].code, c.expect.code)
  })
}

test('the fixtures cover every error code both bindings share, and the server-only ones', () => {
  const codes = new Set(fixtures.cases.filter((c) => c.expect).map((c) => c.expect.code))
  for (const code of ['invalid_shape', 'duplicate_id', 'self_dep', 'unknown_dep', 'cycle', 'unknown_key', 'unknown_repo']) {
    assert.ok(codes.has(code), `no case expects ${code}`)
  }
})

test('the cycle error points at the edge that closes it', () => {
  const result = validatePlanDraft(build({ set: { 'items.0.depends_on': ['#2'] } }))
  assert.deepEqual(result.errors[0], { path: 'items[1].depends_on[0]', code: 'cycle', message: 'cycle: #1 → #2 → #1' })
})

test('the work-item field limits come from domain/fields.json, never the schema file', () => {
  const authored = schema.properties.items.items.properties
  const item = PLAN_DRAFT_SCHEMA.properties.items.items.properties
  for (const name of ['title', 'outcome']) {
    assert.equal(authored[name].maxLength, undefined, `the schema file restates ${name}'s limit`)
    assert.equal(item[name].minLength, fieldByName(name).minLength)
    assert.equal(item[name].maxLength, fieldByName(name).maxLength)
  }
  assert.equal(item.repo.maxLength, fieldByName('repo').maxLength)
  for (const name of ['metric', 'guardrails']) {
    assert.equal(authored[name].maxItems, undefined, `the schema file restates ${name}'s line cap`)
    assert.equal(item[name].maxItems, fieldByName(name).maxLines)
  }
  // The lean-draft floor and the must-also-cover cap are the schema's own.
  assert.deepEqual([item.metric.minItems, item.guardrails.minItems, item.must_also_cover.maxItems], [3, 3, 5])
})

test('the Python binding derives the same schema', () => {
  const script = 'import json; from domain.py import plan_draft; print(json.dumps(plan_draft.SCHEMA))'
  const py = JSON.parse(execFileSync('python3', ['-c', script], { cwd: REPO_ROOT, encoding: 'utf8' }))
  assert.deepEqual(py, PLAN_DRAFT_SCHEMA)
})

test('the schema uses only the keywords both bindings interpret', () => {
  const supported = new Set(['$schema', '$comment', 'title', 'type', 'required', 'additionalProperties', 'properties', 'items'])
  for (const k of ['minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern']) supported.add(k)
  const walk = (node, where) => {
    for (const key of Object.keys(node)) assert.ok(supported.has(key), `${where} uses "${key}"`)
    assert.ok(['object', 'array', 'string'].includes(node.type), `${where} has type ${node.type}`)
    for (const [name, sub] of Object.entries(node.properties || {})) walk(sub, `${where}.${name}`)
    if (node.items) walk(node.items, `${where}[]`)
  }
  walk(schema, '(root)')
})

test('realKeysIn finds keys in depends_on and in text, never a token with an unknown prefix', () => {
  const doc = build({ set: { 'items.2.outcome': 'Builds on HZ-999 and UI-4, sent as UTF-8 over SHA-256.', 'items.1.depends_on': ['#1', 'ZZ-1'] } })
  assert.deepEqual(realKeysIn(doc, ['HZ', 'UI']), ['HZ-446', 'ZZ-1', 'HZ-999', 'UI-4'])
})

test('unknown_key names every unknown key at once', () => {
  const doc = build({ set: { 'items.2.outcome': 'Builds on HZ-999 and HZ-998.' } })
  const result = validatePlanDraft(doc, serverContext)
  assert.equal(result.errors[0].path, 'items[2].outcome')
  assert.match(result.errors[0].message, /^unknown_key: HZ-999, HZ-998 are not existing items/)
})

test('renderPlanDraftMd shows the items table with ids, repo, title and dependencies', () => {
  const md = renderPlanDraftMd(fixtures.base)
  assert.match(md, /^## Draft items\n\n\| ID \| Repo \| Title \| Depends on \| Must also cover \|/)
  assert.match(md, /\n\| #1 \| `FinTekkers\/horizon` \| Plan kind: the draft contract \| HZ-446 \| parity fixtures \|/)
  assert.match(md, /\n\| #2 \| `FinTekkers\/horizon` \| Plan kind: the review flags \| #1 \| — \|/)
  assert.match(md, /## Open questions\n- \*\*Is a closed key a valid dependency\?\*\* Recommended: Yes/)
})

test('the Python binding reports the same first error code for every case (farm view)', () => {
  const script = `
import json, sys
from domain.py import plan_draft
cases = json.load(sys.stdin)
out = []
for doc in cases:
    try:
        plan_draft.validate(doc)
        out.append(None)
    except plan_draft.PlanDraftError as exc:
        out.append(exc.code)
print(json.dumps(out))
`
  const docs = fixtures.cases.map(build)
  const output = execFileSync('python3', ['-c', script], { cwd: REPO_ROOT, input: JSON.stringify(docs), encoding: 'utf8' })
  const expected = fixtures.cases.map((c) => (c.expect === null || c.serverOnly ? null : c.expect.code))
  assert.deepEqual(JSON.parse(output), expected)
})
