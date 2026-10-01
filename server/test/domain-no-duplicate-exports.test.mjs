// HZ-128 success criterion 7: "zero functions defined in both
// server/src/lifecycle.js and ui/src/domain/lifecycle.js. A test asserts the
// intersection of their exported names is empty."
//
// Taken literally that criterion is now trivially satisfied, because
// server/src/lifecycle.js no longer exists — the whole model moved to
// domain/js/lifecycle.js and the file was deleted rather than gutted, so a
// missed import site is an import-time crash instead of a silent `undefined`.
// So this file asserts BOTH halves:
//
//   1. The literal criterion: the server file is gone, and the surviving UI
//      file shares no exported name with the one model module either.
//   2. The HONEST pair. After the move, the only two files that still describe
//      the same thing twice are server/src/agentTokens.js and
//      ui/src/domain/agentTokens.js — both export `AGENTS`. Intersecting the
//      pair that CANNOT collide would certify nothing, so the surviving overlap
//      is asserted to be exactly {AGENTS}: no wider (a new shared export fails
//      here) and no narrower (removing one silently would fail too).
//
// The duplication is reduced, not eliminated: the server persists a literal hex
// into an event row, the UI renders a theme token, so the two maps genuinely
// differ in value while sharing label/initials. Recorded in domain/README.md,
// and personas.test.mjs pins that the shared fields still agree.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { REPO_ROOT } from './helpers/repoFiles.mjs'

const serverAgentTokens = await import('../src/agentTokens.js')
const uiAgentTokens = await import('../../ui/src/domain/agentTokens.js')
const uiLifecycle = await import('../../ui/src/domain/lifecycle.js')
const domainLifecycle = await import('../../domain/js/lifecycle.js')
const domainReasons = await import('../../domain/js/reasons.js')
const domainFields = await import('../../domain/js/fields.js')
const uiPauseReason = await import('../../ui/src/domain/pauseReason.js')

function exportedNames(mod) {
  return new Set(Object.keys(mod).filter((k) => k !== 'default'))
}

function intersection(a, b) {
  return [...a].filter((name) => b.has(name)).sort()
}

test('server/src/lifecycle.js is gone — deleted, not gutted, so a missed import site crashes on import', () => {
  assert.ok(!existsSync(path.join(REPO_ROOT, 'server/src/lifecycle.js')))
})

test('the UI lifecycle file and the one model module share no exported name', () => {
  const ui = exportedNames(uiLifecycle)
  const model = exportedNames(domainLifecycle)
  // Positive control: neither module is empty, so this cannot pass vacuously.
  assert.ok(ui.size > 0, 'ui/src/domain/lifecycle.js exports nothing')
  assert.ok(model.size > 0, 'domain/js/lifecycle.js exports nothing')
  assert.deepEqual(intersection(ui, model), [])
})

test('the UI lifecycle file is presentation only — no step data, no derived helper', () => {
  assert.deepEqual(
    [...exportedNames(uiLifecycle)].sort(),
    ['PHASE_ACCENT', 'PHASE_ACCENT_BG', 'PRIORITY_COLORS', 'priorityColor'],
  )
})

test('the ONE surviving duplicate is exactly {AGENTS}, across the two agentTokens modules', () => {
  const server = exportedNames(serverAgentTokens)
  const ui = exportedNames(uiAgentTokens)
  assert.ok(server.size > 0, 'server/src/agentTokens.js exports nothing')
  assert.ok(ui.size > 0, 'ui/src/domain/agentTokens.js exports nothing')
  assert.deepEqual(intersection(server, ui), ['AGENTS'])
})

// HZ-132: the reason vocabulary and the UI module that renders it are the one
// new pair that could grow a shared export. pauseReason.js owns the COPY and
// domain/js/reasons.js owns the VOCABULARY — re-exporting REASON from the UI
// module, or growing a `label` in the binding, would put the same name in both
// and is what this intersection catches.
test('the one model module for reasons and the UI module that renders them share no exported name', () => {
  const ui = exportedNames(uiPauseReason)
  const model = exportedNames(domainReasons)
  assert.ok(ui.size > 0, 'ui/src/domain/pauseReason.js exports nothing')
  assert.ok(model.size > 0, 'domain/js/reasons.js exports nothing')
  assert.deepEqual(intersection(ui, model), [])
})

test('the three model modules in domain/ share no exported name either', () => {
  const modules = [
    ['lifecycle', exportedNames(domainLifecycle)],
    ['reasons', exportedNames(domainReasons)],
    ['fields', exportedNames(domainFields)],
  ]
  for (const [aName, a] of modules) {
    for (const [bName, b] of modules) {
      if (aName >= bName) continue
      assert.deepEqual(intersection(a, b), [], `domain/js/${aName}.js and domain/js/${bName}.js share an export`)
    }
  }
})

test('the field binding exports the limits and nothing presentational', () => {
  assert.deepEqual(
    [...exportedNames(domainFields)].sort(),
    ['FIELDS', 'assertFieldsShape', 'fieldByName', 'intakeFields', 'patchLimits'],
  )
})

test('the reason binding exports the vocabulary and nothing presentational', () => {
  assert.deepEqual(
    [...exportedNames(domainReasons)].sort(),
    ['AUTO_RETRY_REASONS', 'REASON', 'REASONS', 'REASON_IDS', 'assertReasonsShape', 'isRetryable'],
  )
})

test('neither agentTokens module carries step data — presentation only, both sides', () => {
  for (const [name, mod] of [['server', serverAgentTokens], ['ui', uiAgentTokens]]) {
    const names = exportedNames(mod)
    for (const forbidden of ['STEPS', 'PHASES', 'requiredStepIndex', 'isClosed', 'curStep']) {
      assert.ok(!names.has(forbidden), `${name}/agentTokens.js exports ${forbidden} — the model belongs in domain/`)
    }
  }
})
