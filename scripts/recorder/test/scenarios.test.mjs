// HZ-665: the committed walkthrough scenarios (scripts/recorder/walkthroughs/)
// for the Shoreward video's chapters 1 and 2. Static checks only: no browser,
// so these never skip. The recordings themselves are checked by hand
// (scripts/recorder/README.md).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { EMAIL_RE } from '../browser.mjs'
import { WALKTHROUGH_DIR, expectedMs, loadScenario } from '../walkthrough.mjs'

const NAMES = ['setup', 'create-work']
// A scenario never fills, clicks or opens a login or PIN field.
const LOGIN_FIELD_RE = /pin|password|email|login|sign.?in/i
const LOGIN_PATH_RE = /login|sign.?in|auth/i

function strings(value) {
  if (typeof value === 'string') return [value]
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

// The steps (index and action) that touch a login or PIN field or page.
function loginSteps(actions) {
  return actions.flatMap((a, i) => {
    if ((a.action === 'type' || a.action === 'click') && LOGIN_FIELD_RE.test(a.selector)) return [`${i} ${a.action}`]
    if (a.action === 'goto' && LOGIN_PATH_RE.test(a.path)) return [`${i} goto`]
    return []
  })
}

test('metric 1: loadScenario resolves setup and create-work from the real walkthrough dir', async () => {
  for (const name of NAMES) {
    const scenario = await loadScenario(name)
    assert.equal(scenario.name, name)
    assert.ok(scenario.actions.length > 0)
  }
})

test('metric 2: create-work has exactly one caption', async () => {
  const { actions } = await loadScenario('create-work')
  assert.equal(actions.filter((a) => a.action === 'caption').length, 1)
})

test('metric 3: each scenario\'s fixed times alone add up to more than 10 s', async () => {
  for (const name of NAMES) {
    const ms = expectedMs(await loadScenario(name))
    assert.ok(ms > 10000, `${name}: fixed times add up to ${ms} ms`)
  }
})

test('metric 4: each scenario ends on a waitFor for what only its last click produces', async () => {
  const ends = { setup: '.project-block', 'create-work': '.tracker' }
  for (const name of NAMES) {
    const { actions } = await loadScenario(name)
    const steps = actions.filter((a) => a.action !== 'pause')
    const last = steps.at(-1)
    assert.equal(last.action, 'waitFor', `${name}: last non-pause action is ${last.action}`)
    // The project block exists only once a project does; the tracker only on an item page.
    assert.ok(last.selector.startsWith(ends[name]), `${name}: ends on ${last.selector}`)
    assert.equal(steps.at(-2).action, 'click', `${name}: the final waitFor doesn't follow a click`)
    const earlier = steps.slice(0, -1).map((a) => a.selector).filter(Boolean)
    assert.ok(!earlier.includes(last.selector), `${name}: the final waitFor's selector is used before the click`)
  }
})

test('metric 5: no string in either scenario file matches EMAIL_RE', () => {
  for (const name of NAMES) {
    const raw = JSON.parse(readFileSync(path.join(WALKTHROUGH_DIR, `${name}.json`), 'utf8'))
    const hits = strings(raw).filter((s) => EMAIL_RE.test(s))
    assert.equal(hits.length, 0, `${name}: ${hits.length} string(s) hold an address`)
  }
})

test('metric 5: no action fills or clicks a PIN or login field, or opens a login page', async () => {
  for (const name of NAMES) {
    assert.deepEqual(loginSteps((await loadScenario(name)).actions), [], name)
  }
  // Control: the check does flag them.
  assert.deepEqual(loginSteps([
    { action: 'type', selector: 'input[type=password]', text: 'x', delayMs: 0 },
    { action: 'type', selector: '[aria-label="Gate PIN"]', text: '123456', delayMs: 0 },
    { action: 'click', selector: 'button:has-text("Sign in")' },
    { action: 'goto', path: '/login' },
    { action: 'type', selector: '#note', text: 'fine', delayMs: 0 },
  ]), ['0 type', '1 type', '2 click', '3 goto'])
})
