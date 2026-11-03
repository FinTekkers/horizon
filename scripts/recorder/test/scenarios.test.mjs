// HZ-665: the committed walkthrough scenarios (scripts/recorder/walkthroughs/)
// for the Shoreward video's chapters 1 and 2. Static checks only: no browser,
// so these never skip. The recordings themselves are checked by hand
// (scripts/recorder/README.md).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EMAIL_RE } from '../browser.mjs'
import { SCENES, SCENE_DIR } from '../production.mjs'
import { ENV_ALLOWLIST, WALKTHROUGH_DIR, expectedMs, loadScenario } from '../walkthrough.mjs'

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

// ---- HZ-698: the Shoreward scenes (walkthroughs/shoreward/) ----

// The one sign-in and literal-code scan for the Shoreward scenes (the
// LOGIN_FIELD_RE check above stays as it is for setup and create-work).
// A sign-in step enters a credential: any type or typeEnv into a password,
// Google identifier, login, PIN or one-time-code field; a literal type into
// an email field (a typeEnv from SHOREWARD_TENANT_EMAIL is the sign-up
// form's address, read at run time); or a goto to a sign-in path. Clicks are
// not sign-in steps: A5 clicks Horizon's Sign in button and the saved
// account's tile, and types nothing. A literal code is a type into a promo,
// coupon or code field, or typed text shaped like a code (5+ capitals or
// digits). typeEnv names outside ENV_ALLOWLIST never load.
const SIGN_IN_FIELD_RE = /password|passwd|identifier|login|pin|otp|one.?time|sign.?in/i
const EMAIL_FIELD_RE = /email/i
const SIGN_IN_PATH_RE = /login|sign.?in|oauth|accounts\.google/i
const CODE_FIELD_RE = /promo|coupon|code/i
const CODE_TEXT_RE = /^[A-Z0-9]{5,}$/

function shorewardFindings({ setup = [], actions }) {
  const list = [...setup.map((a, i) => [`setup ${i}`, a]), ...actions.map((a, i) => [`step ${i}`, a])]
  return list.flatMap(([at, a]) => {
    const out = []
    const typing = a.action === 'type' || a.action === 'typeEnv'
    if (typing && SIGN_IN_FIELD_RE.test(a.selector)) out.push(`${at} sign-in`)
    if (a.action === 'type' && EMAIL_FIELD_RE.test(a.selector)) out.push(`${at} sign-in`)
    if (a.action === 'typeEnv' && !ENV_ALLOWLIST.includes(a.env)) out.push(`${at} sign-in`)
    if (a.action === 'goto' && SIGN_IN_PATH_RE.test(a.path)) out.push(`${at} sign-in`)
    if (a.action === 'type' && (CODE_FIELD_RE.test(a.selector) || CODE_TEXT_RE.test(a.text))) out.push(`${at} code`)
    return out
  })
}

test('HZ-698 metric 3: walkthroughs/shoreward/ holds exactly A1-A7, B1-B7 and C1-C7, and each passes the recorder schema', async () => {
  const files = readdirSync(SCENE_DIR).sort()
  assert.deepEqual(files, [...SCENES].sort().map((id) => `${id}.json`))
  assert.equal(SCENES.length, 21)
  for (const id of SCENES) {
    const scene = await loadScenario(id, SCENE_DIR)
    assert.equal(scene.name, id)
    assert.ok(scene.actions.length > 0, id)
    assert.equal(scene.actions[0].action, 'caption', `${id} doesn't open with a caption card`)
  }
})

test('HZ-698 metric 4: no Shoreward scene has a sign-in step or a literal promotion code, and A3 types the code from SHOREWARD_PROMO_CODE', async () => {
  for (const id of SCENES) {
    assert.deepEqual(shorewardFindings(await loadScenario(id, SCENE_DIR)), [], id)
    const raw = JSON.parse(readFileSync(path.join(SCENE_DIR, `${id}.json`), 'utf8'))
    assert.equal(strings(raw).filter((s) => EMAIL_RE.test(s)).length, 0, `${id} holds an address`)
  }
  const a3 = await loadScenario('A3', SCENE_DIR)
  assert.ok(a3.actions.some((a) => a.action === 'typeEnv' && a.env === 'SHOREWARD_PROMO_CODE' && CODE_FIELD_RE.test(a.selector)), 'A3 has no typeEnv of SHOREWARD_PROMO_CODE into the code field')
  // A5 clicks its way through Google's account chooser and types nothing.
  const a5 = await loadScenario('A5', SCENE_DIR)
  assert.ok(a5.actions.some((a) => a.action === 'click' && a.selector === '[data-identifier]'))
  assert.ok(!a5.actions.some((a) => a.action === 'type' || a.action === 'typeEnv'))
  // Control: the scan flags each banned kind, and passes the allowed ones.
  assert.deepEqual(shorewardFindings({
    setup: [{ action: 'type', selector: 'input[type=password]', text: 'x', delayMs: 0 }],
    actions: [
      { action: 'typeEnv', selector: '#identifierId', env: 'SHOREWARD_TENANT_EMAIL', delayMs: 0 },
      { action: 'type', selector: 'input[name="email"]', text: 'parvati', delayMs: 0 },
      { action: 'typeEnv', selector: '#note', env: 'GOOGLE_PASSWORD', delayMs: 0 },
      { action: 'goto', path: '/horizon/api/auth/google/login' },
      { action: 'type', selector: '#promotionCode', text: 'half off', delayMs: 0 },
      { action: 'type', selector: '#note', text: 'LAUNCH50', delayMs: 0 },
      { action: 'type', selector: '[aria-label="Gate PIN"]', text: '1234', delayMs: 0 },
      { action: 'click', selector: '[data-identifier]' },
      { action: 'click', selector: 'button:has-text("Sign in")' },
      { action: 'typeEnv', selector: '#promotionCode', env: 'SHOREWARD_PROMO_CODE', delayMs: 0 },
      { action: 'typeEnv', selector: 'input[name="email"]', env: 'SHOREWARD_TENANT_EMAIL', delayMs: 0 },
      { action: 'type', selector: '#title', text: 'Open-house times', delayMs: 0 },
    ],
  }), ['setup 0 sign-in', 'step 0 sign-in', 'step 1 sign-in', 'step 2 sign-in', 'step 3 sign-in', 'step 4 code', 'step 5 code', 'step 6 sign-in'])
})

test('HZ-698: every class the Horizon-side scenes (A6, A7, B, C) select on is a class in ui/src', async () => {
  const uiSrc = fileURLToPath(new URL('../../../ui/src/', import.meta.url))
  const source = readdirSync(uiSrc, { recursive: true })
    .filter((f) => /\.jsx?$/.test(f) && !/\.test\./.test(f))
    .map((f) => readFileSync(path.join(uiSrc, f), 'utf8'))
    .join('\n')
  for (const id of SCENES.filter((s) => s === 'A6' || s === 'A7' || /^[BC]/.test(s))) {
    const { setup, actions } = await loadScenario(id, SCENE_DIR)
    for (const a of [...setup, ...actions]) {
      if (!a.selector) continue
      // Class names outside quoted text.
      for (const [, cls] of a.selector.replace(/"[^"]*"/g, '').matchAll(/\.([A-Za-z][\w-]*)/g)) {
        assert.ok(new RegExp(`["'\`\\s]${cls}(?![\\w-])`).test(source), `${id}: .${cls} is not a class in ui/src`)
      }
    }
  }
})
