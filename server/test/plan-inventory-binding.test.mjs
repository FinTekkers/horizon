// HZ-462 metric 1: the JS binding for a Plan's Inventory block reads 447a's
// fixed format back out of the artifact. Every valid case in the shared
// domain/fixtures/plan-inventory-cases.json (the cases the Python binding and
// the schema are held to) is wrapped exactly as domain/py/plan_inventory.py's
// render() wraps it, so a format change there fails here too.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { FENCE_INFO, parseInventory } from '../../domain/js/planInventory.js'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

const fixtures = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/fixtures/plan-inventory-cases.json'), 'utf8'))
// render(): f"```{FENCE_INFO}\n{json.dumps(block, indent=2)}\n```"
const rendered = (block) => '```' + FENCE_INFO + '\n' + JSON.stringify(block, null, 2) + '\n```'
const artifact = (block) => `## Current state\n\nProse the agent wrote.\n\n${rendered(block)}`

test('the fence name matches the Python binding', () => {
  const py = readFileSync(path.join(REPO_ROOT, 'domain/py/plan_inventory.py'), 'utf8')
  assert.ok(py.includes(`FENCE_INFO = "${FENCE_INFO}"`))
})

const valid = fixtures.cases.filter((c) => c.valid)
test('the fixture has valid cases to read', () => assert.ok(valid.length >= 2))

for (const c of valid) {
  test(`parses the valid case: ${c.case}`, () => {
    const parsed = parseInventory(artifact(c.block))
    assert.ok(parsed, 'returned null')
    assert.equal(parsed.repos.length, c.block.repos.length)
    assert.equal(parsed.key_facts.length, c.block.key_facts.length)
    assert.deepEqual(parsed, { repos: c.block.repos, key_facts: c.block.key_facts })
  })
}

test('a missing fence, bad JSON or a wrong shape is null, never a throw', () => {
  assert.equal(parseInventory('## Current state\n\nNo block here.'), null)
  assert.equal(parseInventory(undefined), null)
  assert.equal(parseInventory('```json plan-inventory\n{"repos": [\n```'), null)
  assert.equal(parseInventory('```json plan-inventory\nnull\n```'), null)
  assert.equal(parseInventory(rendered({ repos: [{ repo: 'a/b', has: 'not a list', gaps: [], evidence: [] }], key_facts: [] })), null)
})

test('the last fence wins, as extract() takes the last match', () => {
  const [first, second] = valid
  const parsed = parseInventory(`${rendered(first.block)}\n\n${rendered(second.block)}`)
  assert.deepEqual(parsed.repos, second.block.repos)
})
