// HO-854: docs/project-substeps.md, the guide a project owner follows to turn
// on "Design the screens". It must cover the path, how `anchor` works, the
// `design` output, the credential env var, the intake freeze and the
// definitions_enabled default, and must name the credential only as an env
// var, never with a value. docs/README.md links it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

const DOC_PATH = path.join(REPO_ROOT, 'docs', 'project-substeps.md')
const doc = readFileSync(DOC_PATH, 'utf8')
const CREDENTIAL = 'SCREENSHOT_LOGIN_KEY'

test('the doc names the path, anchor, design output, credential, freeze and switch default', () => {
  assert.ok(doc.includes('farm/projects/<slug>/steps.json'), 'the file path')
  assert.match(doc, /`anchor`/, 'how anchor works')
  assert.ok(doc.includes('"anchor": 1'), "Horizon's anchor")
  assert.ok(doc.includes('"output": "design"'), "Horizon's output value")
  assert.match(doc, /`artifact`/, 'the other opening output')
  assert.ok(doc.includes(CREDENTIAL), 'the credential env var name')
  assert.match(doc, /definitions_enabled[\s\S]{0,80}defaults to `1`/, 'the definitions_enabled default')
  assert.match(doc, /new items only/i, 'the intake-freeze caveat')
})

test('the doc never gives the credential a value', () => {
  // Any assignment or colon after the name is a value; only the bare name,
  // `$NAME` and `<placeholder>` text are allowed.
  for (const [i, line] of doc.split('\n').entries()) {
    if (!line.includes(CREDENTIAL)) continue
    assert.doesNotMatch(line, new RegExp(`${CREDENTIAL}\\s*[=:]\\s*(?!<)\\S`), `line ${i + 1} gives ${CREDENTIAL} a value: ${line}`)
  }
  assert.doesNotMatch(doc, /\bgh[pousr]_[A-Za-z0-9]{20,}/, 'a GitHub token shape')
  assert.doesNotMatch(doc, /\bsk-ant-[A-Za-z0-9-]{10,}/, 'an Anthropic key shape')
})

test('the value check catches an assignment (positive control)', () => {
  const pattern = new RegExp(`${CREDENTIAL}\\s*[=:]\\s*(?!<)\\S`)
  assert.match(`${CREDENTIAL}=abc123`, pattern)
  assert.match(`export ${CREDENTIAL}: hunter2`, pattern)
  assert.doesNotMatch(`${CREDENTIAL}=<random>`, pattern)
  assert.doesNotMatch(`For Horizon that variable is \`$${CREDENTIAL}\`.`, pattern)
})

test('docs/README.md links the doc as a list item', () => {
  const index = readFileSync(path.join(REPO_ROOT, 'docs', 'README.md'), 'utf8')
  assert.match(index, /^- \[`project-substeps\.md`\]\(project-substeps\.md\)/m)
})
