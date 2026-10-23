// HZ-563 metric 2: the Farm health state, derived from fixture inputs — one
// case per rule, each with a non-empty one-line reason, and red wins.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-farm-health-rules-')), 'test.db')
for (const key of ['FARM_HOME', 'FARM_URL']) delete process.env[key]

const { deriveHealth, UNITS } = await import('../src/farmHealth.js')

const allUp = () => UNITS.map((u) => ({ name: u.name, up: true }))

// Green: every service up, slots free, figures normal.
const normal = () => ({
  farm: { status: 'running' },
  services: allUp(),
  capacity: { agents: { busy: 1, limit: 4 } },
  waitingCount: 0,
  box: { load1: 2, vcpus: 4, memAvailablePct: 50, diskUsedPct: 60 },
})

function assertOneLine(reason) {
  assert.equal(typeof reason, 'string')
  assert.ok(reason.trim().length > 0, 'reason is empty')
  assert.ok(!reason.includes('\n'), `reason spans lines: ${JSON.stringify(reason)}`)
}

function check(name, mutate, expected) {
  test(`${expected}: ${name}`, () => {
    const inputs = normal()
    mutate(inputs)
    const health = deriveHealth(inputs)
    assert.equal(health.state, expected)
    assertOneLine(health.reason)
  })
}

check('all services up, slots free and figures normal', () => {}, 'green')

check('every agent slot is busy', (i) => (i.capacity.agents = { busy: 4, limit: 4 }), 'amber')
check('something is waiting for a slot', (i) => (i.waitingCount = 1), 'amber')
check('1-minute load is 1.3x the vCPUs', (i) => (i.box.load1 = 5.2), 'amber')
check('available memory is 14%', (i) => (i.box.memAvailablePct = 14), 'amber')
check('disk is 80%', (i) => (i.box.diskUsedPct = 80), 'amber')

check('one service is down', (i) => (i.services[3].up = false), 'red')
check('the farm is not running', (i) => (i.farm.status = 'not_running'), 'red')
check('disk is 91%', (i) => (i.box.diskUsedPct = 91), 'red')

test('red wins over amber', () => {
  const inputs = normal()
  inputs.capacity.agents = { busy: 4, limit: 4 }
  inputs.waitingCount = 3
  inputs.box = { load1: 9, vcpus: 4, memAvailablePct: 5, diskUsedPct: 80 }
  inputs.services[0].up = false
  const health = deriveHealth(inputs)
  assert.equal(health.state, 'red')
  assert.match(health.reason, /horizon-server is down/)
  assertOneLine(health.reason)
})

test('the farm-not-running reason names the farm', () => {
  const inputs = normal()
  inputs.farm.status = 'not_running'
  assert.equal(deriveHealth(inputs).reason, 'Farm is not running')
})

test('UNITS are the 12 services ~/post-migration-check.sh checks', () => {
  assert.deepEqual(
    UNITS.map((u) => u.unit),
    [
      'horizon-server',
      'horizon-farm',
      'nginx',
      'postgresql@16-main',
      'fintekkers-ui',
      'fintekkers-ledger',
      'fintekkers-valuation',
      'fintekkers-broker',
      'fintekkers-price',
      'whatsapp-bridge',
      'shoreward-contact',
      'earlyoom',
    ],
  )
})
