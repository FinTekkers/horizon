// HZ-489: a Muse step's "See agent output ↗" view shows the same kind of lines
// a Claude step's does — timestamped tool calls and the agent's text — as they
// arrive. The Muse log is farm/tests/fixtures/muse_stream_expected.log, the
// lines farm/providers/muse_stream.py renders from a recorded Muse run (a farm
// test proves that). The Claude log is the format
// farm/tests/test_providers_claude_print_event.py pins.
//
// The e2e server has no farm, so its /api/runs/:runId/log answers 503. This
// spec stubs that route and serves each log in two pages, so the view appends
// live, then reports the run finished.

import { readFileSync } from 'node:fs'
import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, insertStepRun } from '../fixtures/seed.js'
import { STEPS, IMPLEMENT_STEP_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const MUSE = 'HZ-E2E-MUSE-LOG'
const CLAUDE = 'HZ-E2E-CLAUDE-LOG'
const FARM_DOWN = 'HZ-E2E-FARM-DOWN-LOG'
const sqliteNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const runIds = {}

const LOGS = {
  [MUSE]: readFileSync(new URL('../../farm/tests/fixtures/muse_stream_expected.log', import.meta.url), 'utf8'),
  [CLAUDE]: [
    '[12:01:02] Reading the runner first.',
    '[12:01:02] ⏺ Read({"file_path": "farm/farmd.py"})',
    '[12:01:02] ⏺ Grep({"pattern": "def run", "path": "farm"})',
    '[12:01:03] ⏺ Bash({"command": "python -m pytest farm/tests/test_farmd.py"})',
    '[12:01:40] The farmd tests pass.',
    '[12:01:41] ── result: 7 turn(s) in 42s ──',
    '',
  ].join('\n'),
}

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    for (const id of [MUSE, CLAUDE, FARM_DOWN]) {
      // beforeAll re-runs in a fresh worker after a failed test; seed once.
      const seeded = db.prepare('SELECT id FROM step_run WHERE item_id = ? AND step_index = ? ORDER BY id DESC').get(id, IMPLEMENT_STEP_INDEX)
      if (seeded) {
        runIds[id] = seeded.id
        continue
      }
      insertItem(db, { id, title: `E2E fixture — an implement step streaming its agent output (${id})`, cursor: IMPLEMENT_STEP_INDEX })
      runIds[id] = Number(
        insertStepRun(db, {
          itemId: id,
          stepIndex: IMPLEMENT_STEP_INDEX,
          attempt: 1,
          agent: STEPS[IMPLEMENT_STEP_INDEX].agent,
          status: 'active',
          startedAt: sqliteNow(),
        }),
      )
    }
  } finally {
    db.close()
  }
})

// The farm's log route for one run: the first half of the log, then the rest
// on the next poll, then nothing more and the run inactive.
async function serveLogInTwoPages(context, id) {
  const content = LOGS[id]
  const half = content.indexOf('\n', Math.floor(content.length / 2)) + 1
  const pages = { 0: { content: content.slice(0, half), next_offset: half, active: true } }
  pages[half] = { content: content.slice(half), next_offset: content.length, active: true }
  pages[content.length] = { content: '', next_offset: content.length, active: false }
  await context.route(
    (url) => url.pathname.endsWith(`/api/runs/${runIds[id]}/log`),
    (route) => {
      const offset = Number(new URL(route.request().url()).searchParams.get('offset'))
      return route.fulfill({ json: pages[offset] ?? pages[content.length] })
    },
  )
  return half
}

async function openAgentOutput(page, id) {
  const half = await serveLogInTwoPages(page.context(), id)
  await page.goto(`/${id.toLowerCase()}`)
  const [view] = await Promise.all([page.waitForEvent('popup'), page.getByRole('link', { name: 'See agent output ↗' }).click()])
  const log = view.locator('#log')
  // Live appending: the first page renders before the second arrives.
  await expect(log).toHaveText(LOGS[id].slice(0, half), { timeout: 10_000 })
  await expect(view.locator('#status')).toHaveText('Run finished.', { timeout: 15_000 })
  await expect(log).toHaveText(LOGS[id])
  return (await log.textContent()).split('\n').filter(Boolean)
}

// What a line is, without its timestamp or contents: the shape both
// providers' lines must share.
function shape(line) {
  if (!/^\[\d\d:\d\d:\d\d\] /.test(line)) return 'unstamped'
  const body = line.slice(11)
  if (/^⏺ [A-Za-z]+\(.*\)$/.test(body)) return 'tool'
  if (/^── result: \d+ turn\(s\) in \d+s ──$/.test(body)) return 'result'
  return 'text'
}

test('a Muse step’s agent output view shows its tool calls and text lines the way a Claude step’s does', async ({ page }) => {
  const muse = await openAgentOutput(page, MUSE)
  const claude = await openAgentOutput(page, CLAUDE)

  for (const tool of ['Bash', 'Read', 'Search']) {
    expect(muse.filter((line) => line.includes(`] ⏺ ${tool}(`))).toHaveLength(1)
  }
  for (const tool of ['Bash', 'Read', 'Grep']) {
    expect(claude.filter((line) => line.includes(`] ⏺ ${tool}(`))).toHaveLength(1)
  }
  expect(muse.map(shape)).not.toContain('unstamped')
  expect(claude.map(shape)).not.toContain('unstamped')
  expect(new Set(muse.map(shape))).toEqual(new Set(['tool', 'text', 'result']))
  expect(new Set(claude.map(shape))).toEqual(new Set(muse.map(shape)))
  expect(muse.at(-1)).toMatch(/── result: 4 turn\(s\) in 19s ──$/)
})

// HZ-717: while the server can't reach the farm the log route answers 503
// `farm unavailable`. The view says so, keeps polling, and once a read
// succeeds shows the log and drops that status.
test('the agent output view says when the farm can’t be reached, and recovers when it answers', async ({ page }, testInfo) => {
  const LINE = '[12:02:00] Back after the farm returned.\n'
  let calls = 0
  await page.context().route(
    (url) => url.pathname.endsWith(`/api/runs/${runIds[FARM_DOWN]}/log`),
    (route) => {
      calls += 1
      if (calls === 1) return route.fulfill({ status: 503, json: { error: 'farm unavailable' } })
      const offset = Number(new URL(route.request().url()).searchParams.get('offset'))
      return route.fulfill({ json: offset === 0 ? { content: LINE, next_offset: LINE.length, active: false } : { content: '', next_offset: LINE.length, active: false } })
    },
  )
  await page.goto(`/${FARM_DOWN.toLowerCase()}`)
  const [view] = await Promise.all([page.waitForEvent('popup'), page.getByRole('link', { name: 'See agent output ↗' }).click()])
  const status = view.locator('#status')
  await expect(status).toHaveText('Can’t reach the farm. Retrying…', { timeout: 10_000 })
  await expect(view.locator('#log')).toHaveText('Waiting for output…')
  for (const colorScheme of ['light', 'dark']) {
    await view.emulateMedia({ colorScheme })
    await testInfo.attach(`agent-output-farm-down-${colorScheme}`, { body: await view.screenshot(), contentType: 'image/png' })
  }

  await expect(view.locator('#log')).toHaveText(LINE, { timeout: 10_000 })
  await expect(status).toHaveText('Run finished.', { timeout: 10_000 })
})
