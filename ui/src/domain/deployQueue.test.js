// HZ-481: the deploy line follows the batch through its stages — open, the
// drain, deploying, live with the smoke check — in the viewer's local HH:MM,
// and falls back to the HZ-333 wording whenever a fact is missing or unknown.

import { expect, test } from 'vitest'
import { deployQueueLabel } from './deployQueue'

// In October New York is UTC-4: 04:52Z reads 00:52 there.
const NOW = Date.parse('2026-10-15T04:49:00Z')
const TAG = 'deploy-horizon-20261015-b122'
const queue = (extra) => ({
  deploy_queue: {
    target: 'horizon',
    status: 'queued',
    batch_status: 'open',
    window_closes_at: '2026-10-15T04:52:00Z',
    tag: null,
    batch_id: 122,
    started_at: null,
    live_at: null,
    ...extra,
  },
})
const OPEN = queue({})
const DRAIN = queue({
  batch_status: 'deploying',
  tag: TAG,
  started_at: '2026-10-15T05:05:00Z',
  drain_started_at: '2026-10-15T05:08:00Z',
  drain_deadline: '2026-10-15T05:18:00Z',
  drain_waiting: [
    { item_id: 'HZ-449', step: 'implement' },
    { item_id: 'HZ-458', step: 'premerge' },
    { item_id: 'HZ-469', step: 'premerge' },
  ],
  deploying_since: '2026-10-15T05:05:00Z',
  live_eta: '2026-10-15T05:20:00Z',
})
const DEPLOYING = queue({
  batch_status: 'deploying',
  tag: TAG,
  started_at: '2026-10-15T05:12:00Z',
  deploying_since: '2026-10-15T05:12:00Z',
  live_eta: '2026-10-15T05:14:00Z',
})
const LIVE = queue({ status: 'released', batch_status: 'verifying', tag: TAG, started_at: '2026-10-15T05:12:00Z', live_at: '2026-10-15T05:14:00Z' })

function inTimeZone(tz, fn) {
  const saved = process.env.TZ
  process.env.TZ = tz
  try {
    return fn()
  } finally {
    if (saved === undefined) delete process.env.TZ
    else process.env.TZ = saved
  }
}

test('metric 1: each of the four stages reads as specified, in the viewer local HH:MM', () => {
  inTimeZone('America/New_York', () => {
    // A TZ switch that did nothing would read these as UTC.
    expect(new Date(NOW).getTimezoneOffset()).not.toBe(0)
    expect(deployQueueLabel(OPEN, NOW)).toBe('next horizon deploy (b122) · window closes 00:52 (in 3 min)')
    expect(deployQueueLabel(DRAIN, NOW)).toBe(
      'horizon deploy b122 · waiting for 3 running steps (HZ-449 implement, HZ-458 premerge, HZ-469 premerge) · goes ahead by 01:18 at the latest',
    )
    expect(deployQueueLabel(DEPLOYING, NOW)).toBe('horizon deploy b122 · deploying since 01:12 · live about 01:14')
    expect(deployQueueLabel(LIVE, NOW)).toBe('b122 live at 01:14 · smoke check running')
  })
})

test('metric 4: a ui-service deploy with no drain facts never says "waiting for"', () => {
  const item = queue({ target: 'ui-service', batch_status: 'deploying', tag: 'deploy-ui-service-b7', batch_id: 7, deploying_since: '2026-10-15T05:12:00Z' })
  const label = deployQueueLabel(item, NOW)
  expect(label).toMatch(/^ui-service deploy b7 · deploying since \d\d:\d\d$/)
  expect(label).not.toMatch(/waiting for/)
})

test('one waiting step reads singular; an empty wait list reads as deploying', () => {
  inTimeZone('America/New_York', () => {
    const one = { deploy_queue: { ...DRAIN.deploy_queue, drain_waiting: [{ item_id: 'HZ-449', step: 'implement' }] } }
    expect(deployQueueLabel(one, NOW)).toBe('horizon deploy b122 · waiting for 1 running step (HZ-449 implement) · goes ahead by 01:18 at the latest')
    const none = { deploy_queue: { ...DRAIN.deploy_queue, drain_waiting: [] } }
    expect(deployQueueLabel(none, NOW)).toBe('horizon deploy b122 · deploying since 01:05 · live about 01:20')
  })
})

test('a window already closed drops the "(in N min)" suffix', () => {
  inTimeZone('America/New_York', () => {
    expect(deployQueueLabel(OPEN, Date.parse('2026-10-15T04:53:00Z'))).toBe('next horizon deploy (b122) · window closes 00:52')
  })
})

test('metric 5: missing or unknown facts read as today, never throw and never blank', () => {
  const without = (fixture, ...keys) => {
    const q = { ...fixture.deploy_queue }
    for (const key of keys) delete q[key]
    return { deploy_queue: q }
  }
  const cases = [
    // No batch id: no stage can name its batch.
    [without(OPEN, 'batch_id'), /^waiting for next horizon deploy · window closes \d\d:\d\d$/],
    [without(DRAIN, 'batch_id'), `riding the horizon deploy ${TAG}`],
    [without(LIVE, 'batch_id'), null],
    // Missing drain facts and missing durations.
    [without(DRAIN, 'drain_deadline', 'drain_waiting', 'deploying_since', 'live_eta'), `riding the horizon deploy ${TAG}`],
    [queue({ ...DRAIN.deploy_queue, drain_deadline: 'soon', deploying_since: undefined }), `riding the horizon deploy ${TAG}`],
    [without(DEPLOYING, 'live_eta'), /^horizon deploy b122 · deploying since \d\d:\d\d$/],
    [queue({ ...DEPLOYING.deploy_queue, live_eta: 'not a time' }), /^horizon deploy b122 · deploying since \d\d:\d\d$/],
    [queue({ window_closes_at: 'not a time' }), 'waiting for next horizon deploy'],
    [queue({ ...LIVE.deploy_queue, live_at: null }), null],
    // Unknown statuses, and a publishing batch.
    [queue({ status: 'mystery' }), null],
    [queue({ batch_status: 'mystery', tag: TAG }), `riding the horizon deploy ${TAG}`],
    [queue({ batch_status: 'publishing', tag: TAG }), `riding the horizon deploy ${TAG}`],
    [queue({ ...LIVE.deploy_queue, batch_status: 'done' }), null],
    [{ deploy_queue: null }, null],
    [{}, null],
    [null, null],
  ]
  for (const [item, expected] of cases) {
    let label
    expect(() => {
      label = deployQueueLabel(item, NOW)
    }).not.toThrow()
    expect(label).not.toBe('')
    if (expected instanceof RegExp) expect(label).toMatch(expected)
    else expect(label).toBe(expected)
  }
})
