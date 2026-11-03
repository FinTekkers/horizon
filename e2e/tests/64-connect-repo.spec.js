// HZ-703: "Connect your repository", in the browser, on a real member's board.
// Each member creates their project through "Set up your first project", so
// the board frames — and the project fields they carry — are the server's
// own. Only the connect POST is stubbed (CI reaches no GitHub); after a
// stubbed success the spec writes the repo row the real connect would have,
// so the next real frame carries it, as in production.
//
// Each member sets their own gate PIN first: earlier specs rotate the
// suite's, and a refused PIN would open a prompt and hang the test.

import { test, expect } from '../fixtures/test-base.js'
import { PRIORITIES } from '../../domain/js/priorities.js'
import { openDb, insertItem, insertProject, insertMemberSession, setGatePinDirect } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const BASE_URL = process.env.HORIZON_E2E_BASE_URL
const CARD = 'Connect your repository'
const CONNECTED = 'Repository connected'
const PIN = '640364'
const TOKEN = 'github_pat_11E2ECONNECTREPO0secretTOKENvalue64'
const REPO = 'E2EConnect/site'
const REFUSAL = `A classic token's repo scope reaches every repository you can. Create a fine-grained token limited to ${REPO} only.`
const CONNECT_ROUTE = '**/api/tenant/projects/*/repos'

let journeyMember
let shotsMember
const seededRepos = []
test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    const ownerProject = insertProject(db, { name: 'E2E Connect Repo Owner' })
    // As in 61-first-project: pin a global active project, so a member's
    // create never becomes the host's first project.
    db.prepare("INSERT OR IGNORE INTO setting (key, value) VALUES ('active_project_id', ?)").run(String(ownerProject))
    // A gate cursor: nothing for a mock agent to pick up.
    insertItem(db, { id: 'CR-O1', title: 'E2E connect repo — owner item', cursor: 3, project_id: ownerProject })
    journeyMember = insertMemberSession(db, { email: 'e2e-connect-journey@example.com', name: 'Connect Journey' })
    shotsMember = insertMemberSession(db, { email: 'e2e-connect-shots@example.com', name: 'Connect Shots' })
    setGatePinDirect(db, 'e2e-connect-journey@example.com', PIN)
    setGatePinDirect(db, 'e2e-connect-shots@example.com', PIN)
  } finally {
    db.close()
  }
})

// A seeded repo row is polled for the rest of the suite (seed.js), so it goes.
test.afterAll(() => {
  const db = openDb(DB_PATH)
  try {
    for (const repo of seededRepos) db.prepare('DELETE FROM project_repo WHERE repo = ?').run(repo)
  } finally {
    db.close()
  }
})

// A page signed in as `who`, holding their gate PIN, with no owner cookie. It
// records page errors and console output, and fails any GitHub request.
async function memberPage(browser, who) {
  const context = await browser.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } })
  await context.addCookies([{ name: 'horizon_session', value: who.token, url: BASE_URL }])
  await context.addInitScript((pin) => localStorage.setItem('horizon_gate_pin', pin), PIN)
  const page = await context.newPage()
  const githubHits = []
  await page.route(/^https?:\/\/(?:[a-z0-9-]+\.)?github\.com\//i, (route) => {
    githubHits.push(route.request().url())
    route.abort('failed')
  })
  const errors = []
  const consoleLines = []
  page.on('pageerror', (err) => errors.push(err.message))
  page.on('console', (msg) => consoleLines.push(msg.text()))
  return { context, page, errors, consoleLines, githubHits }
}

async function createProject(page, name) {
  await page.goto('/')
  await page.getByLabel('Project name').fill(name)
  await page.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: CARD })).toBeVisible()
}

// Stubs only the connect POST; `answer` is { status, body }. Returns the
// bodies it received.
async function stubConnect(page, answer) {
  const sent = []
  await page.route(CONNECT_ROUTE, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    sent.push(route.request().postDataJSON())
    await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body) })
  })
  return sent
}

const success = (projectId) => ({
  status: 200,
  body: {
    ok: true,
    repo: REPO,
    prefix: 'ECR',
    defaultBranch: 'main',
    githubTokenRef: `$HZ_TENANT_${projectId}`,
    runUser: 'e2econnect',
    webhook: { status: 'ok', lastResponseCode: null, reason: null },
  },
})

const refused = { status: 400, body: { error: 'token_too_broad', message: REFUSAL } }

async function fillAndConnect(page) {
  await page.getByLabel('Repository', { exact: true }).fill(REPO)
  await page.getByLabel('Token', { exact: true }).fill(TOKEN)
  await page.getByRole('button', { name: 'Connect repository' }).click()
}

function projectIdOf(name) {
  const db = openDb(DB_PATH)
  try {
    return db.prepare('SELECT id FROM project WHERE name = ?').get(name).id
  } finally {
    db.close()
  }
}

let priorityTurn = 0
async function triggerFrame(request) {
  const priority = PRIORITIES[priorityTurn++ % PRIORITIES.length]
  const res = await request.post('/api/items/CR-O1/priority', { data: { priority } })
  expect(res.ok()).toBeTruthy()
}

test('metrics 1–4: a member connects from the card, sees the result, and the board takes the repository', async ({ browser, request }) => {
  const { context, page, errors, consoleLines, githubHits } = await memberPage(browser, journeyMember)
  try {
    const name = 'E2E Connect Journey Co'
    await createProject(page, name)
    const newItem = page.getByRole('button', { name: '+ New work item' })
    await expect(newItem).toBeDisabled()

    // Metric 4: the token link, checked and never opened.
    await page.getByLabel('Repository', { exact: true }).fill(REPO)
    const link = page.getByRole('link', { name: /Create a token on GitHub/ })
    await expect(link).toHaveAttribute('target', '_blank')
    const href = new URL(await link.getAttribute('href'))
    expect(`${href.origin}${href.pathname}`).toBe('https://github.com/settings/personal-access-tokens/new')
    expect(href.searchParams.get('target_name')).toBe('E2EConnect')
    expect(href.searchParams.get('contents')).toBe('write')
    expect(href.searchParams.get('metadata')).toBe('read')

    // Metric 2: a refusal shows the server's message; the token is cleared.
    await stubConnect(page, refused)
    await fillAndConnect(page)
    await expect(page.getByRole('alert').locator('strong')).toHaveText(REFUSAL)
    await expect(page.getByLabel('Token', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('Repository', { exact: true })).toHaveValue(REPO)

    // Metric 1: success. The stub checks the body is exactly { repo, token }.
    await page.unroute(CONNECT_ROUTE)
    const projectId = projectIdOf(name)
    const sent = await stubConnect(page, success(projectId))
    await fillAndConnect(page)
    await expect(page.getByRole('heading', { name: CONNECTED })).toBeVisible()
    expect(sent).toEqual([{ repo: REPO, token: TOKEN }])
    for (const line of [CONNECTED, 'Webhook created', 'Run user ready']) {
      await expect(page.locator('.connect-repo__result strong', { hasText: line })).toBeVisible()
    }
    // HZ-741 metric 5: the card says which repo the token is used for.
    await expect(page.getByText(`Horizon uses this token only for ${REPO}.`)).toBeVisible()

    // Metric 3: the token is nowhere the browser keeps or shows things.
    expect(await page.content()).not.toContain(TOKEN)
    expect(consoleLines.join('\n')).not.toContain(TOKEN)
    const kept = await page.evaluate(() =>
      [localStorage, sessionStorage]
        .flatMap((s) => Object.keys(s).map((k) => `${k}=${s.getItem(k)}`))
        .concat(document.cookie)
        .join('\n'),
    )
    expect(kept).not.toContain(TOKEN)
    expect(page.url()).not.toContain(TOKEN)

    // The real connect's repo row, then a real frame: the result stays up.
    const db = openDb(DB_PATH)
    try {
      db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(projectId, REPO, 'ECR')
      seededRepos.push(REPO)
    } finally {
      db.close()
    }
    await triggerFrame(request)
    await expect(newItem).toBeEnabled({ timeout: 5000 })
    await expect(page.getByRole('heading', { name: CONNECTED })).toBeVisible()

    // Metric 4: the check commands page, from the connected view.
    await page.getByRole('link', { name: 'Set your check commands' }).click()
    await expect(page).toHaveURL(/\/admin\/checks$/)
    await expect(page.getByRole('heading', { name: "Your project's check commands" })).toBeVisible()
    await expect(page.getByText(REPO, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Back to board' }).click()

    await page.getByRole('button', { name: 'File your first item' }).click()
    await expect(page.getByRole('heading', { name: CONNECTED })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: CARD })).toHaveCount(0)
    await expect(newItem).toBeEnabled()

    await page.reload()
    await expect(page.locator('.board__title')).toBeVisible()
    await expect(page.getByRole('heading', { name: CARD })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '+ New work item' })).toBeEnabled()
    expect(errors).toEqual([])
    expect(githubHits).toEqual([])
  } finally {
    await context.close()
  }
})

// Metric 5 (manual): the PR's light and dark screens of each state, and the
// phone width. Each shot waits for its state's text, and checks
// html[data-theme] first, so a "dark" shot can never silently be light.
test('metric 5: the card in its empty, refused and connected states, light and dark, and at phone width', async ({ browser }, testInfo) => {
  const { context, page, errors, githubHits } = await memberPage(browser, shotsMember)
  const shot = async (name) => {
    // The viewport is tall enough for the whole card: a full-page shot would
    // paint the sticky top bar and fixed bottom nav where the page scrolled.
    const path = testInfo.outputPath(`${name}.png`)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path })
    await testInfo.attach(name, { path, contentType: 'image/png' })
  }
  try {
    await page.setViewportSize({ width: 1440, height: 1120 })
    await createProject(page, 'E2E Connect Shots Co')
    let answer = refused
    await page.route(CONNECT_ROUTE, (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body) })
        : route.fallback(),
    )
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme })
      await page.goto('/')
      await expect(page.getByRole('heading', { name: CARD })).toBeVisible()
      expect(await page.locator('html').getAttribute('data-theme'), theme).toBe(theme === 'dark' ? 'dark' : null)
      await shot(`connect-repo--empty--${theme}`)

      answer = refused
      await fillAndConnect(page)
      await expect(page.getByRole('alert').locator('strong')).toHaveText(REFUSAL)
      await shot(`connect-repo--refused--${theme}`)

      answer = success(1)
      await page.getByLabel('Token', { exact: true }).fill(TOKEN)
      await page.getByRole('button', { name: 'Connect repository' }).click()
      await expect(page.getByRole('heading', { name: CONNECTED })).toBeVisible()
      await shot(`connect-repo--connected--${theme}`)
    }

    await page.emulateMedia({ colorScheme: 'light' })
    await page.setViewportSize({ width: 390, height: 1400 })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: CARD })).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await shot('connect-repo--phone--light')
    expect(errors).toEqual([])
    expect(githubHits).toEqual([])
  } finally {
    await context.close()
  }
})
