// HZ-563 metric 2: the Farm health state, derived from fixture inputs — one
// case per rule, each with a non-empty one-line reason, and red wins.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-farm-health-rules-')), 'test.db')
for (const key of ['FARM_HOME', 'FARM_URL']) delete process.env[key]

const { deriveHealth, buildServiceRows } = await import('../src/farmHealth.js')

// HZ-595: deploy targets as listTargets() returns them, in rowid order.
const TARGETS = [
  { key: 'ui-service', service: 'fintekkers-ui', healthUrl: 'https://www.fintekkers.org/', healthCheckType: 'ssr-asset-check' },
  { key: 'broker', service: 'fintekkers-broker', healthUrl: 'http://127.0.0.1:8085', healthCheckType: 'grpc-health' },
  { key: 'market-data-inputs', service: '', healthUrl: 'https://github.com/FinTekkers/market-data-inputs', healthCheckType: 'deploy-log' },
  { key: 'ledger-models', service: null, healthUrl: 'https://pypi.org/project/ledger-models/', healthCheckType: 'registry-publish' },
  { key: 'price', service: 'fintekkers-price', healthUrl: 'http://localhost:8083/', healthCheckType: 'grpc-health' },
  { key: 'shoreward', service: 'shoreward-contact', healthUrl: 'https://shoreward.ai/', healthCheckType: 'json-health' },
  {
    key: 'horizon',
    service: 'horizon-server',
    healthUrl: 'http://127.0.0.1:3001/api/health',
    healthCheckType: 'json-health',
    extraServices: ['horizon-farm', 'nginx'],
  },
  // A second target naming a unit already shown adds no row.
  { key: 'zz-copy', service: 'fintekkers-price', healthUrl: 'http://127.0.0.1:9999/', healthCheckType: 'json-health' },
]

const allUp = () => buildServiceRows(TARGETS).map((u) => ({ name: u.name, up: true }))

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
  assert.match(health.reason, /fintekkers-broker is down/)
  assertOneLine(health.reason)
})

test('the farm-not-running reason names the farm', () => {
  const inputs = normal()
  inputs.farm.status = 'not_running'
  assert.equal(deriveHealth(inputs).reason, 'Farm is not running')
})

test('deploy targets give the service rows: by key, then the box units, each unit once (HZ-595)', () => {
  const rows = buildServiceRows(TARGETS)
  assert.deepEqual(
    rows.map((r) => [r.unit, r.name, r.detail]),
    [
      ['fintekkers-broker', 'fintekkers-broker', 'gRPC :8085'],
      ['horizon-server', 'horizon-server', ':3001'],
      ['horizon-farm', 'horizon-farm', null],
      // nginx came in as horizon's extra service, so the box unit adds no second row.
      ['nginx', 'nginx', null],
      ['fintekkers-price', 'fintekkers-price', 'gRPC :8083'],
      ['shoreward-contact', 'shoreward-contact', null],
      ['fintekkers-ui', 'fintekkers-ui', null],
      ['postgresql@16-main', 'postgresql', null],
      ['whatsapp-bridge', 'whatsapp-bridge', null],
      ['earlyoom', 'earlyoom', null],
    ],
  )
  const units = rows.map((r) => r.unit)
  assert.equal(new Set(units).size, units.length, 'a unit appears twice')
  assert.ok(!units.includes('') && !units.includes(null), 'a target without a service gave a row')
})

test('a gRPC health target on a public or unparsable URL shows the label but no port (HZ-595)', () => {
  const rows = buildServiceRows(
    [
      { key: 'a', service: 'svc-a', healthUrl: 'https://grpc.example.com:8443/', healthCheckType: 'grpc-health' },
      { key: 'b', service: 'svc-b', healthUrl: 'not a url', healthCheckType: 'grpc-health' },
      { key: 'c', service: 'svc-c', healthUrl: 'http://127.0.0.1/', healthCheckType: 'toString' },
    ],
    [],
  )
  assert.deepEqual(rows.map((r) => r.detail), ['gRPC', 'gRPC', null])
})

test('a unit name that systemctl would read as an option gives no row (HZ-595)', () => {
  const rows = buildServiceRows(
    [
      { key: 'a', service: '--host=evil', healthUrl: 'http://127.0.0.1:1/', healthCheckType: 'json-health', extraServices: ['skipped-too'] },
      { key: 'b', service: 'ok-unit', healthUrl: 'http://127.0.0.1:2/', healthCheckType: 'json-health', extraServices: ['-H', 'a b', 'ok-extra'] },
    ],
    [],
  )
  assert.deepEqual(rows.map((r) => r.unit), ['ok-unit', 'ok-extra'])
})
