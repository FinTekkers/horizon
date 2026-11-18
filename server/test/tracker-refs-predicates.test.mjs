// HO-901 metric 5: the named predicates behind every server/src check on an
// item's `issue`. A null issue means either a local demo item (no repo) or an
// sl Task-backed item (a repo on the sl backend); the predicates tell them
// apart from the item's own repo, issue and backend alone.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasGithubIssue, isLocalItem, isTaskBackedItem, hasTrackerRef, trackerRefText } from '../src/trackerRefs.js'

const ROWS = [
  // [name, item, hasGithubIssue, isLocalItem, isTaskBackedItem]
  ['a local demo item', { id: 'D-1', repo: null, issue: null, backend: 'github' }, false, true, false],
  ['a GitHub item with its issue', { id: 'G-1', repo: 'acme/web', issue: 12, backend: 'github' }, true, false, false],
  ['a GitHub item with a repo and no issue', { id: 'G-2', repo: 'acme/web', issue: null, backend: 'github' }, false, false, false],
  ['an sl item (null issue, a Task)', { id: 'S-1', repo: 'acme/sl', issue: null, task_id: '41', backend: 'sl' }, false, false, true],
  ['an sl item with a non-null issue', { id: 'S-2', repo: 'acme/sl', issue: 7, task_id: '42', backend: 'sl' }, false, false, true],
  ['a repo+issue object with no backend field (reads as GitHub)', { id: 'N-1', repo: 'acme/web', issue: 3 }, true, false, false],
  ['a demo object with no backend field', { id: 'N-2', repo: null, issue: null }, false, true, false],
  ['null', null, false, false, false],
  ['undefined', undefined, false, false, false],
]

for (const [name, item, github, local, taskBacked] of ROWS) {
  test(`${name}: hasGithubIssue ${github}, isLocalItem ${local}, isTaskBackedItem ${taskBacked}`, () => {
    assert.equal(hasGithubIssue(item), github)
    assert.equal(isLocalItem(item), local)
    assert.equal(isTaskBackedItem(item), taskBacked)
  })
}

test('hasGithubIssue is true only for the GitHub repo+issue items', () => {
  assert.deepEqual(
    ROWS.filter(([, item]) => hasGithubIssue(item)).map(([name]) => name),
    ['a GitHub item with its issue', 'a repo+issue object with no backend field (reads as GitHub)'],
  )
})

test('isLocalItem is true for a demo item and false for an sl Task-backed item', () => {
  assert.equal(isLocalItem({ id: 'D-1', repo: null, issue: null }), true)
  assert.equal(isLocalItem({ id: 'S-1', repo: 'acme/sl', issue: null, task_id: '41', backend: 'sl' }), false)
})

test("an sl item's tracker record is its Task, never an issue — even with a stray issue number", () => {
  const item = { id: 'S-2', repo: 'acme/sl', issue: 7, task_id: '42', backend: 'sl' }
  assert.equal(hasTrackerRef(item), true)
  assert.equal(trackerRefText(item), 'Task 42')
  assert.equal(trackerRefText({ id: 'G-1', repo: 'acme/web', issue: 12, backend: 'github' }), 'issue #12')
})
