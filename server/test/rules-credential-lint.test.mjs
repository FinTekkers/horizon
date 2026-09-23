// Credential-leak sweep over the real farm/ tree (QA review, HZ-22).
//
// lintRules() (mirrored in farm/rules.py's lint_rules()) only runs today
// when a role/rules file is saved through the UI's editor
// (writeDefinition() in definitions.js) — a file added directly via a git
// commit, which is how every role and rules file in this repo actually
// got there, never passes through it. This test closes that gap by running
// the same lint directly over every committed role and rules file.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { lintRules, MAX_DEFINITION_BYTES } from '../src/definitions.js'

const FARM_DIR = path.resolve(import.meta.dirname, '../../farm')

function markdownFiles(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return markdownFiles(full)
    return entry.isFile() && entry.name.endsWith('.md') ? [full] : []
  })
}

const FILES = [...markdownFiles(path.join(FARM_DIR, 'roles')), ...markdownFiles(path.join(FARM_DIR, 'rules'))]

test('every committed role/rules file has at least one .md file to check', () => {
  assert.ok(FILES.length > 0)
})

test('no committed role/rules file contains a credential pattern', () => {
  for (const file of FILES) {
    const content = fs.readFileSync(file, 'utf8')
    const matches = lintRules(content)
    assert.deepEqual(matches, [], `${path.relative(FARM_DIR, file)} matched credential pattern(s): ${matches.join(', ')}`)
  }
})

test('no committed role/rules file exceeds the size the UI editor would accept', () => {
  for (const file of FILES) {
    const bytes = Buffer.byteLength(fs.readFileSync(file, 'utf8'), 'utf8')
    assert.ok(bytes <= MAX_DEFINITION_BYTES, `${path.relative(FARM_DIR, file)} is ${bytes} bytes (cap ${MAX_DEFINITION_BYTES})`)
  }
})
