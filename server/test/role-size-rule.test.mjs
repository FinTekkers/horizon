// HZ-685: the planning roles treat the 15-file / 600-line rule as a soft
// guideline that ignores generated code, propose a split only well over it
// (or for independent parts), and let an owner ruling on size win.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

const ROLES = ['farm/roles/eng_plan.md', 'farm/roles/architect_review.md', 'farm/roles/pm.md']
const SIZE_LINE = /15[- ]files?|600[- ](production )?lines?/i
// Prose wraps, so phrases are matched on the file with its line breaks folded.
const read = (path) => readFileSync(join(REPO_ROOT, path), 'utf8')
const folded = (text) => text.replace(/\s+/g, ' ')

for (const path of ROLES) {
  test(`${path}: the size rule is a soft guideline, never blocking or required, and the numbers are unchanged`, () => {
    const text = read(path)
    const sizeLines = text.split('\n').filter((line) => SIZE_LINE.test(line))
    assert.ok(sizeLines.length > 0, 'the file still states the rule')
    for (const line of sizeLines) assert.doesNotMatch(line, /blocking|required/i, line)
    assert.match(folded(text), /15 files or 600 production lines/i, 'the numbers stay 15 files and 600 production lines')
    assert.match(folded(text), /soft guideline/i)
  })

  test(`${path}: generated code is excluded — bindings, .js/.d.ts/.js.map build output, lockfiles, mirrored data files`, () => {
    const text = folded(read(path))
    for (const phrase of ['Generated code does not count', 'bindings', '`.js`', '`.d.ts`', '`.js.map`', 'lockfiles', 'mirrored data files']) {
      assert.ok(text.includes(phrase), `missing ${phrase}`)
    }
  })

  test(`${path}: a split only at roughly twice the limit or for independent parts, and an owner ruling on size wins`, () => {
    const text = folded(read(path))
    assert.match(text, /roughly twice the limit or more, or naturally ships in independent parts/)
    assert.match(text, /owner ruling on the item's size \(for example a stated limit\) always wins/)
    assert.match(text, /modestly over the guideline (?:should )?notes? the overrun and carr(?:y|ies) on/)
  })
}
