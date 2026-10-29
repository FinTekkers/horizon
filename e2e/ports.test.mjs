import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickOffset, RESTRICTED_PORTS, UI_BASE, SERVER_BASE, OFFSET_RANGE } from './ports.js'

test('no offset 0-999 yields a Chromium-restricted UI or server port', () => {
  for (let offset = 0; offset < OFFSET_RANGE; offset++) {
    const picked = pickOffset(offset)
    assert.ok(!RESTRICTED_PORTS.has(UI_BASE + picked), `offset ${offset} -> UI ${UI_BASE + picked}`)
    assert.ok(!RESTRICTED_PORTS.has(SERVER_BASE + picked), `offset ${offset} -> server ${SERVER_BASE + picked}`)
  }
})

test('offsets whose ports were already safe keep their ports', () => {
  for (let offset = 0; offset < OFFSET_RANGE; offset++) {
    if (RESTRICTED_PORTS.has(UI_BASE + offset) || RESTRICTED_PORTS.has(SERVER_BASE + offset)) continue
    assert.equal(pickOffset(offset), offset)
  }
})

test('the restricted offsets move to the next safe one', () => {
  assert.equal(pickOffset(602), 603) // server 3659
  assert.equal(pickOffset(709), 711) // UI 5060
  assert.equal(pickOffset(710), 711) // UI 5061 (HZ-595)
  assert.equal(pickOffset(988), 989) // server 4045
  for (const port of [3659, 4045, 5060, 5061]) assert.ok(RESTRICTED_PORTS.has(port))
})
