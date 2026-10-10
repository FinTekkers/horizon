// HZ-381: server/src/personas.js reads persona ids, agent membership and role
// files from domain/personas.json only — the file declares no persona id as a
// string literal, and its hand-typed display table covers the domain ids
// exactly, in both directions.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { PERSONA_AGENTS, PERSONA_IDS } from '../../domain/js/personas.js'
import { PERSONAS, PERSONA_DISPLAY } from '../src/personas.js'
import { REPO_ROOT, stripComments } from './helpers/repoFiles.mjs'

const doc = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/personas.json'), 'utf8'))
const IDS = new Set(doc.agents.flatMap((entry) => entry.personas))

// [start, end] of the LEGACY_PERSONA_IDS object literal in comment-stripped
// code, or null when the file declares none (a re-export has no literal to
// exempt). Brace-matched, so a literal on the statement after the declaration
// is outside the span.
function legacySpan(code) {
  const open = /LEGACY_PERSONA_IDS\s*=\s*\{/.exec(code)
  if (!open) return null
  let depth = 0
  for (let i = open.index; i < code.length; i++) {
    if (code[i] === '{') depth += 1
    else if (code[i] === '}') {
      depth -= 1
      if (depth === 0) return [open.index, i]
    }
  }
  return null
}

const QUOTED = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g

function flaggedIdLiterals(code, ids) {
  const stripped = stripComments(code)
  const span = legacySpan(stripped)
  const flagged = []
  for (const match of stripped.matchAll(QUOTED)) {
    if (span && match.index >= span[0] && match.index <= span[1]) continue
    const value = match[0].slice(1, -1).replace(/\\(.)/g, '$1')
    if (ids.has(value)) flagged.push({ index: match.index, value })
  }
  return flagged
}

test('server/src/personas.js declares no persona id as a string literal', () => {
  assert.equal(IDS.size, 11, 'positive control: the scan compares against a real id set')
  const source = readFileSync(path.join(REPO_ROOT, 'server/src/personas.js'), 'utf8')
  assert.deepEqual(flaggedIdLiterals(source, IDS), [])
})

test('the server scan flags a single-quoted and a double-quoted persona id', () => {
  assert.deepEqual(
    flaggedIdLiterals("const chosen = 'python'\n", IDS).map((hit) => hit.value),
    ['python'],
  )
  assert.deepEqual(
    flaggedIdLiterals('const chosen = "api_contract"\n', IDS).map((hit) => hit.value),
    ['api_contract'],
  )
})

test('the server scan exempts only the legacy aliases declaration', () => {
  const source = "export const LEGACY_PERSONA_IDS = {\n  fullstack: ['eng', 'ui'],\n}\nconst chosen = 'ui'\n"
  assert.deepEqual(
    flaggedIdLiterals(source, IDS).map((hit) => hit.value),
    ['ui'],
  )
})

test('the server display table covers exactly the domain ids, in both directions', () => {
  assert.deepEqual(Object.keys(PERSONA_DISPLAY).sort(), [...PERSONA_AGENTS].sort())
  for (const agent of PERSONA_AGENTS) {
    assert.deepEqual(Object.keys(PERSONA_DISPLAY[agent]).sort(), [...PERSONA_IDS[agent]].sort(), agent)
  }
})

test('the server registry order is todays order', () => {
  const expected = {
    eng: ['fullstack', 'python', 'ui', 'performance'],
    qa: ['api_contract', 'e2e_journey', 'data_integrity'],
    architect: ['data_modelling', 'distributed_systems'],
    pm: ['roadmap', 'feature_development'],
  }
  assert.deepEqual(Object.keys(PERSONAS), Object.keys(expected))
  for (const [agent, ids] of Object.entries(expected)) {
    assert.deepEqual(Object.keys(PERSONAS[agent]), ids, agent)
  }
})
