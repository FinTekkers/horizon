// HZ-114 success metric, literally: "a test enumerates the sites this item
// changes and asserts that each either fits or produces a marked,
// boundary-aligned cut — so a future reintroduction fails CI rather than
// shipping quietly."
//
// The behavior of each site is already covered case-by-case in
// store.test.mjs / definitions.test.mjs. This file is the single checklist
// the success metric asks for: one entry per JS-side site this item
// touched, each proven to either carry oversized input through in full, or
// cut it at a boundary with a marker that says so.
//
// The Python-side sites (farm/rules.py, farm/pm_agent.py, farm/step_agent.py)
// have the equivalent checklist in farm/tests/test_hz114_no_silent_truncation.py.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-hz114-')), 'test.db')

const store = await import('../src/store.js')
const { renderRulesSection, MAX_PROMPT_RULES_CHARS } = await import('../src/definitions.js')

function siteStoreParseIssueBodyDesc() {
  // Site: server/src/store.js parseIssueBody — HZ-113's root cause. No real
  // boundary defends 500 chars here (work_item.desc is plain SQLite TEXT),
  // so the fix is that oversized input now fits in full, not that it gets a
  // marked cut.
  const filler = 'x'.repeat(600)
  const body = `## Outcome\n${filler} REQUIRED-DETAIL-PAST-CHAR-500`
  const parsed = store.parseIssueBody(body)
  return parsed.desc.includes('REQUIRED-DETAIL-PAST-CHAR-500')
}

function siteDefinitionsRenderRulesSection() {
  // Site: server/src/definitions.js renderRulesSection — the JS mirror of
  // farm/rules.py's raw text[:CAP] slice named in the outcome.
  const oversized = 'q'.repeat(MAX_PROMPT_RULES_CHARS + 3000)
  const rendered = renderRulesSection([oversized])
  const fits = rendered.includes(oversized)
  const markedBoundaryCut =
    !fits &&
    !rendered.includes(oversized) &&
    !rendered.includes('q'.repeat(MAX_PROMPT_RULES_CHARS)) &&
    rendered.includes('rules block(s) omitted') &&
    rendered.toLowerCase().includes('do not infer')
  return fits || markedBoundaryCut
}

const SITES = [
  ['server/src/store.js parseIssueBody() — desc past char 500 (HZ-113)', siteStoreParseIssueBodyDesc],
  ['server/src/definitions.js renderRulesSection() — oversized rules block', siteDefinitionsRenderRulesSection],
]

test('every HZ-114 changed JS site either fits or produces a marked boundary cut', () => {
  const failures = SITES.filter(([, check]) => !check()).map(([name]) => name)
  assert.deepEqual(failures, [])
})

test('the checklist itself is not empty', () => {
  assert.ok(SITES.length >= 2)
})
