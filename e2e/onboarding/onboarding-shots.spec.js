// HZ-400: walks docs/project-onboarding.md through the real UI and API of the
// demo server, and writes each step's screenshot to docs/images/onboarding/.
// Not part of `npm --prefix e2e test`: only e2e/onboarding.config.js loads
// this directory, via `npm --prefix e2e run screenshots:onboarding`.
//
// Each test drives the UI to the state the doc's "Done when:" line describes
// and asserts it before the shot, so a run is also a check that the steps
// still work. Two things demo mode cannot do are stood in for, and only
// those: GitHub (the repo row is inserted directly, as in
// 28-deploy-target-overrides.spec.js, and the webhook status is stubbed in
// the browser) and the GitHub issue a first item files (step 9 inserts the
// item row itself).
//
// The tests run in the order an owner actually does the steps: step 5 comes
// after step 8, because Deploy target overrides lists only repos of enabled
// projects (Known gaps in the doc).

import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject, insertProjectRepo, setGatePinDirect } from '../fixtures/seed.js'
import base from '../playwright.config.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
// Its own PIN: earlier specs rotate it, and this one never reads theirs.
const GATE_PIN = '482913'
const PROJECT = 'Example Co'
const REPO = 'example-org/example-app'
const PREFIX = 'EX'
// How /definitions lists them: the project name slugged, the repo with
// '/' as '__' (server/src/definitions.js rulesKey).
const PROJECT_RULES_KEY = 'example-co'
const REPO_RULES_KEY = 'example-org__example-app'
const FIRST_ITEM = { id: 'EX-1', title: 'Add a health endpoint to example-app' }
const SHOTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/images/onboarding')
// A GitHub token's shape. The token panel's placeholder names the prefixes
// with no body after them, so it never matches.
const TOKEN_PATTERN = /\b(?:ghp|gho|ghs|ghu|ghr|github_pat)_[A-Za-z0-9_]{8,}/

let projectId = null
let webhookHits = 0

test.beforeAll(async ({ request }, testInfo) => {
  // Fail fast unless this is the isolated demo server: a temp DB, a local
  // base URL, and a server started with no GitHub token or repo.
  expect(DB_PATH, 'HORIZON_E2E_DB is unset — run through e2e/onboarding.config.js').toBeTruthy()
  expect(relative(tmpdir(), DB_PATH).startsWith('..'), `HORIZON_E2E_DB must be under ${tmpdir()}`).toBe(false)
  expect(new URL(testInfo.project.use.baseURL).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/)
  const serverEnv = base.webServer[0].env
  expect(serverEnv.GITHUB_TOKEN, 'the server must start with GITHUB_TOKEN blank').toBe('')
  expect(serverEnv.HORIZON_REPO, 'the server must start with HORIZON_REPO blank').toBe('')
  const { sync } = await (await request.get('/api/items')).json()
  expect(sync?.tokenConfigured, 'the demo server must have no GitHub token').toBeFalsy()

  mkdirSync(SHOTS_DIR, { recursive: true })
  const db = openDb(DB_PATH)
  try {
    // A project that already exists, as on a real Horizon: only the first
    // project ever made starts enabled, so this makes Example Co start
    // disabled the way Shoreward did.
    if (!db.prepare('SELECT 1 FROM project WHERE name = ?').get('Horizon')) {
      const existing = insertProject(db, { name: 'Horizon', enabled: true })
      db.prepare("INSERT OR REPLACE INTO setting (key, value) VALUES ('active_project_id', ?)").run(String(existing))
    }
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

test.beforeEach(async ({ page }) => {
  await stubWebhook(page, 'ok')
})

async function stubWebhook(page, status) {
  await page.unroute('**/api/projects/*/repos/webhooks')
  await page.route('**/api/projects/*/repos/webhooks', (route) => {
    webhookHits += 1
    route.fulfill({
      json: { webhooks: [{ repo: REPO, status, lastResponseCode: status === 'ok' ? 200 : null, reason: null }] },
    })
  })
}

// No GitHub token shape anywhere on the page, in text or in a field.
async function expectNoSecrets(page) {
  const text = await page.evaluate(
    () =>
      document.body.innerText +
      '\n' +
      [...document.querySelectorAll('input, textarea')].map((el) => (el.type === 'password' ? '' : el.value)).join('\n'),
  )
  expect(text).not.toMatch(TOKEN_PATTERN)
}

// Writes docs/images/onboarding/<name>.png. Unlike captureScreenshot, a
// failed capture fails the run: these files are the doc.
async function shot(page, name, target = page) {
  await expectNoSecrets(page)
  // The sticky top bar would otherwise cover a panel taller than the viewport.
  await target.screenshot({
    path: join(SHOTS_DIR, `${name}.png`),
    animations: 'disabled',
    style: target === page ? undefined : '.topbar { position: static !important; }',
  })
}

const panel = (page, title) =>
  page.locator('.admin__panel').filter({ has: page.locator('.panel__title', { hasText: title }) })
const projectBlock = (page) =>
  page.locator('.project-block').filter({ has: page.locator('.project-block__name', { hasText: new RegExp(`^${PROJECT}$`) }) })

async function openAdmin(page) {
  await page.goto('/admin')
  await expect(page.locator('.admin__title')).toHaveText('Admin', { timeout: 10_000 })
}

test('before you start — GitHub access and the gate PIN', async ({ page }) => {
  await openAdmin(page)
  const github = panel(page, 'GitHub access')
  await expect(github.getByText('No token yet')).toBeVisible()
  // The token panel never shows a token value: the field is empty.
  await expect(github.locator('input[type=password]')).toHaveValue('')
  await shot(page, '00-github-access', github)
  await shot(page, '00-gate-pin', panel(page, 'Security · your gate PIN'))
})

test('step 1 — create the project', async ({ page }) => {
  await openAdmin(page)
  const projects = panel(page, /^Projects$/)
  await projects.getByPlaceholder('New project name, e.g. Shoreward').fill(PROJECT)
  await projects.getByRole('button', { name: 'Create project' }).click()
  await expect(projectBlock(page)).toBeVisible()
  await expect(projectBlock(page).getByText('Disabled', { exact: true })).toBeVisible()
  await expect(projectBlock(page).getByText('No repositories connected yet.')).toBeVisible()
  await shot(page, '01-create-project', projectBlock(page))

  const db = openDb(DB_PATH)
  try {
    projectId = db.prepare('SELECT id FROM project WHERE name = ?').get(PROJECT).id
  } finally {
    db.close()
  }
})

test('step 2 — connect the repo; the webhook is verified', async ({ page }) => {
  expect(projectId, 'step 1 must run first').toBeTruthy()
  // Connect validates the repo against GitHub, which demo mode has no token
  // for, so the row goes in directly — what a successful Connect stores.
  const db = openDb(DB_PATH)
  try {
    if (!db.prepare('SELECT 1 FROM project_repo WHERE repo = ?').get(REPO)) {
      insertProjectRepo(db, { projectId, repo: REPO, prefix: PREFIX })
    }
  } finally {
    db.close()
  }

  // What the owner sees if the webhook could not be made: Fix webhook.
  await stubWebhook(page, 'missing')
  webhookHits = 0
  await openAdmin(page)
  const block = projectBlock(page)
  await expect(block.getByText('Webhook: missing')).toBeVisible()
  await expect(block.getByRole('button', { name: 'Fix webhook' })).toBeVisible()
  await shot(page, '02-webhook-missing', block)

  await stubWebhook(page, 'ok')
  await page.reload()
  await expect(projectBlock(page).getByText('Webhook: ok')).toBeVisible({ timeout: 10_000 })
  await expect(projectBlock(page).getByText('last delivery 200')).toBeVisible()
  await expect(projectBlock(page).getByRole('button', { name: 'Fix webhook' })).toHaveCount(0)
  expect(webhookHits).toBeGreaterThan(0)
  await shot(page, '02-repo-connected', projectBlock(page))
})

test('step 3 — set the check commands', async ({ page }) => {
  await openAdmin(page)
  const block = projectBlock(page)
  await expect(block.getByText('no checks configured: items in this repo will fail at implement')).toBeVisible()
  await block.getByRole('button', { name: /Check commands/ }).click()
  await block.getByLabel(`Install command for ${REPO}`).fill('npm ci')
  await block.getByLabel(`Test command for ${REPO}`).fill('npm test')
  await block.getByLabel(`Lint command for ${REPO}`).fill('npm run lint')
  await block.getByLabel(`Gate PIN to save check commands for ${REPO}`).fill(GATE_PIN)
  await block.getByRole('button', { name: 'Save commands' }).click()
  await expect(block.getByText('Check commands saved.')).toBeVisible()
  await expect(block.getByText('no checks configured: items in this repo will fail at implement')).toHaveCount(0)
  await shot(page, '03-check-commands', block)
})

async function saveRules(page, group, key, text, name) {
  await page.goto('/definitions')
  await page
    .locator('.defs__group')
    .filter({ has: page.locator('.defs__group-title', { hasText: group }) })
    .locator('.defs__item', { hasText: key })
    .click()
  await expect(page.getByText('No rules — no file and no saved version.')).toBeVisible({ timeout: 10_000 })
  await page.getByLabel('Definition content').fill(text)
  await page.getByLabel('Gate PIN to save or restore rules').fill(GATE_PIN)
  await page.getByRole('button', { name: 'Save new version' }).click()
  await expect(page.getByText('Saved as version 1')).toBeVisible()
  await expect(page.getByText('Agents get saved version 1.')).toBeVisible()
  await shot(page, name, page.locator('.defs__editor'))
}

test('step 4 — set the project and repo rules', async ({ page }) => {
  await saveRules(
    page,
    /^Projects$/,
    PROJECT_RULES_KEY,
    '# Example Co\n\n- example-app is the only service; it has no database.\n- Never commit .env files.',
    '04-project-rules',
  )
  await saveRules(
    page,
    /^Repositories$/,
    REPO_RULES_KEY,
    '# example-org/example-app\n\n- Node 22. Install with `npm ci`, test with `npm test`.\n- The app listens on $PORT.',
    '04-repo-rules',
  )
})

test('step 6 — choose the provider and model defaults', async ({ page }) => {
  await openAdmin(page)
  const runsOn = projectBlock(page).locator('.project-autopilot').filter({ hasText: 'Runs on' })
  const selects = runsOn.locator('select')
  expect(await selects.count()).toBeGreaterThan(0)
  for (const select of await selects.all()) await expect(select).toHaveValue('default')
  await shot(page, '06-runs-on', runsOn)

  await page.goto('/definitions')
  await page.getByText('Models — which Claude model each agent call uses').click()
  const models = page.getByRole('table', { name: 'Effective model per step' })
  await expect(models).toBeVisible()
  await shot(page, '06-models', models)
})

test('step 7 — the pre-flight, by hand until Validate project ships', async ({ page }) => {
  await openAdmin(page)
  const block = projectBlock(page)
  await expect(block.getByText('Webhook: ok')).toBeVisible({ timeout: 10_000 })
  await expect(block.getByText('no checks configured: items in this repo will fail at implement')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Validate project' })).toHaveCount(0)
  await shot(page, '07-preflight-by-hand', block)
})

test('step 8 — enable the project; Autopilot stays off', async ({ page }) => {
  await openAdmin(page)
  const block = projectBlock(page)
  await block.getByRole('switch', { name: `${PROJECT} enabled` }).click()
  await block.getByLabel(`Gate PIN to enable ${PROJECT}`).fill(GATE_PIN)
  await block.getByRole('button', { name: 'Enable', exact: true }).click()
  await expect(block.getByText('Enabled', { exact: true })).toBeVisible()
  await expect(block.getByRole('switch', { name: `${PROJECT} enabled` })).toHaveAttribute('aria-checked', 'true')
  await expect(block.getByLabel(`${PROJECT} Autopilot`)).toHaveValue('off')
  await shot(page, '08-enabled', block)
})

test('step 5 — add the deploy target and Dry run it (after step 8)', async ({ page }) => {
  await openAdmin(page)
  const row = panel(page, 'Deploy target overrides').getByRole('group', { name: `Deploy target for ${REPO}` })
  await expect(row.getByText('none', { exact: true })).toBeVisible({ timeout: 10_000 })
  await row.getByRole('button', { name: 'Add target' }).click()
  // The script and service must already be in infra/host/ and
  // horizon-deploy.sudoers; this demo reuses an existing pair.
  await row.getByLabel('Key', { exact: true }).fill('example-app')
  await row.getByLabel('Script', { exact: true }).fill('deploy-ui-service.sh')
  await row.getByLabel('Service', { exact: true }).fill('fintekkers-ui')
  await row.getByLabel('Repo dir', { exact: true }).fill('/opt/example/example-app')
  await row.getByLabel('State key', { exact: true }).fill('example-app')
  await row.getByLabel('Health URL', { exact: true }).fill('http://127.0.0.1:9/')
  await row.getByLabel('Health check type', { exact: true }).fill('http-200')
  await shot(page, '05-deploy-target-form', row)
  await row.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByLabel(`Gate PIN to save deploy target for ${REPO}`).fill(GATE_PIN)
  await page.getByRole('button', { name: 'Confirm save' }).click()
  await expect(row.getByText('example-app', { exact: true })).toBeVisible()
  await expect(row.getByText('deploy-ui-service.sh')).toBeVisible()

  const targets = panel(page, /^Deploy targets$/)
  const target = targets
    .locator('div')
    .filter({ has: page.getByText(REPO, { exact: true }) })
    .filter({ has: page.getByRole('button', { name: /Dry run/ }) })
    .last()
  await target.getByRole('button', { name: /Dry run/ }).click()
  await page.getByLabel(`Gate PIN to dry-run ${REPO}`).fill(GATE_PIN)
  await target.getByRole('button', { name: 'Run', exact: true }).click()
  const results = page.getByRole('list', { name: `Dry run results for ${REPO}` }).getByRole('listitem')
  await expect(results).toHaveCount(5, { timeout: 15_000 })
  for (const item of await results.all()) {
    await expect(item.locator('.deploy-dry-run__badge')).toHaveText(/^(pass|fail)$/)
    await expect(item.locator('.deploy-dry-run__reason')).not.toBeEmpty()
  }
  await shot(page, '05-dry-run', target)
})

test('step 9 — file and watch a first small item', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '+ New work item' }).click()
  const modal = page.locator('.composer__panel')
  const pick = modal.getByRole('button', { name: PROJECT, exact: true })
  if (await pick.count()) await pick.click()
  await expect(modal.locator('.composer__title')).toHaveText(`New work item · ${PROJECT}`)
  await expect(modal.getByText(`Creates an issue in ${REPO}`)).toBeVisible()
  await modal.getByPlaceholder(/One line naming the work/).fill(FIRST_ITEM.title)
  await modal
    .getByPlaceholder(/Risk managers get a live view/)
    .fill('GET /health answers 200 with {"ok":true}, so the deploy health check has something to call.')
  await modal.getByPlaceholder(/Limit breaches acknowledged/).fill('curl -fsS localhost:$PORT/health exits 0 after a deploy.')
  // The form scrolls inside the panel: show its top, with the project.
  await modal.evaluate((el) => el.scrollTo(0, 0))
  await shot(page, '09-new-item')
  // Create work item would file a GitHub issue, which demo mode cannot: the
  // row it leads to goes in directly, untouched by the mock agents.
  await page.keyboard.press('Escape')

  const db = openDb(DB_PATH)
  try {
    if (!db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(FIRST_ITEM.id)) {
      insertItem(db, { ...FIRST_ITEM, priority: 'Low', cursor: 0, repo: REPO, project_id: projectId })
    }
  } finally {
    db.close()
  }
  await page.goto('/')
  await page.getByRole('button', { name: /^Project filter:/ }).click()
  await page.getByRole('menuitemradio', { name: PROJECT }).click()
  await expect(page.getByRole('button', { name: `Project filter: ${PROJECT}` })).toBeVisible()
  const card = page.locator('.card').filter({ hasText: FIRST_ITEM.title })
  await expect(card).toHaveCount(1, { timeout: 10_000 })
  await expect(card).toContainText(FIRST_ITEM.id)
  await shot(page, '09-first-item')
})
