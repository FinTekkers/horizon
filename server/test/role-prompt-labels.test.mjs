// farm/roles/*.md quote step labels at the agents. farm/roles/pm.md names three
// of them to tell the PM agent which step it is performing, and nothing guarded
// that: rename a label in the table and the Python drift check fires on
// STEP_CONFIG while the role prompt silently instructs the agent about a step
// that no longer exists.
//
// HZ-128's premise is that the safeguards concentrate at one boundary. A role
// prompt is one of the places the model leaks out of domain/, so it gets a
// guard here rather than a note.
//
// The check is one-directional on purpose: every quoted string in a role file
// that LOOKS like a step label must be one. Requiring the reverse (every label
// is quoted somewhere) would be wrong — most steps are never named in a prompt.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { STEPS } from '../../domain/js/lifecycle.js'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

const ROLES_DIR = path.join(REPO_ROOT, 'farm/roles')
const labels = new Set(STEPS.map((s) => s.label))

// A step label, as these prompts write them: a double-quoted phrase starting
// with a capital, several words long. Deliberately narrow — it must not sweep in
// every quoted noun in a 200-line prompt.
const QUOTED_PHRASE = /"([A-Z][^"\n]{8,60})"/g

// Quoted phrases introduced with a colon that are NOT step labels. Empty today:
// the only four in the tree (all in pm.md) are real labels. Kept as an explicit
// constant so a genuinely-not-a-label phrase gets classified here, on purpose,
// rather than the whole check being loosened.
const NOT_A_STEP_LABEL = new Set([])

function roleFiles() {
  return readdirSync(ROLES_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(ROLES_DIR, f))
}

test('sanity: there are role prompts to check, and the label set is populated', () => {
  assert.ok(roleFiles().length > 0, 'no role prompts found')
  // HZ-377: 16 change labels plus 11 task labels, minus the shared opener.
  assert.equal(labels.size, 26)
})

test('every step-label-shaped quoted phrase in a role prompt names a real step', () => {
  const unknown = []
  for (const file of roleFiles()) {
    const text = readFileSync(file, 'utf8')
    for (const [, phrase] of text.matchAll(QUOTED_PHRASE)) {
      if (labels.has(phrase) || NOT_A_STEP_LABEL.has(phrase)) continue
      // Only phrases that read like a step instruction — followed by a colon,
      // which is how these prompts introduce a step: a bullet, the label in
      // double quotes, then a colon. (No real label is written out here, so
      // this file is not itself a hit for the one-declaration allowlist.)
      if (!new RegExp(`"${escapeRegExp(phrase)}"\\s*:`).test(text)) continue
      unknown.push(`${path.relative(REPO_ROOT, file)}: "${phrase}"`)
    }
  }
  assert.deepEqual(unknown, [], `role prompt(s) name a step that is not in the table:\n  ${unknown.join('\n  ')}`)
})

test('POSITIVE CONTROL: farm/roles/pm.md really does quote real step labels', () => {
  const text = readFileSync(path.join(ROLES_DIR, 'pm.md'), 'utf8')
  const quoted = [...text.matchAll(QUOTED_PHRASE)].map(([, phrase]) => phrase).filter((p) => labels.has(p))
  assert.ok(quoted.length >= 2, `pm.md quotes only ${quoted.length} real step label(s) — the regex is probably wrong`)
})

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
