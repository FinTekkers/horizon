// HZ-773: a fresh tenant is never asked for a PIN they were not shown. A paid
// sign-up (seeded as sign-up, payment and first Google login leave it: a PIN
// hash no one has seen) opens "Set up your first project", is shown their
// gate PIN once, and creates their project. Their first repo connect then
// goes to the real server, which answers the PIN 401; PinDialog opens, and
// the PIN read off the screen passes the server's real PIN check.
//
// CI reaches no GitHub, so only GitHub's side is replaced: the retried POST
// (the one carrying the PIN) is forwarded to the real server with a classic
// token, which it refuses with token_too_broad only after the PIN check and
// before any GitHub call — a wrong PIN would be 401. The browser then gets
// the success a real connect answers, and the spec writes the repo row it
// would have left, as 64-connect-repo does.

import { test, expect } from '../fixtures/test-base.js'
import { PRIORITIES } from '../../domain/js/priorities.js'
import { openDb, insertItem, insertProject, insertSignupUser } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const BASE_URL = process.env.HORIZON_E2E_BASE_URL
const HEADING = 'Set up your first project'
const CARD = 'Connect your repository'
const CONNECTED = 'Repository connected'
const PROJECT = 'E2E First PIN Co'
const REPO = 'E2EFirstPin/site'
const TOKEN = 'github_pat_11E2EFIRSTPIN0secretTOKENvalue66'
// Refused by the server's token check before it calls GitHub.
const CLASSIC_TOKEN = `ghp_${'E'.repeat(36)}`
const CONNECT_ROUTE = '**/api/tenant/projects/*/repos'

let tenant
const seededRepos = []
test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    const ownerProject = insertProject(db, { name: 'E2E First PIN Owner' })
    // As in 61-first-project: pin a global active project, so the tenant's
    // create never becomes the host's first project.
    db.prepare("INSERT OR IGNORE INTO setting (key, value) VALUES ('active_project_id', ?)").run(String(ownerProject))
    // A gate cursor: nothing for a mock agent to pick up.
    insertItem(db, { id: 'FPIN-O1', title: 'E2E first PIN — owner item', cursor: 3, project_id: ownerProject })
    tenant = insertSignupUser(db, { email: 'e2e-first-pin@example.com', name: 'First Pin Tenant', company: 'First Pin Co' })
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
  const res = await request.post('/api/items/FPIN-O1/priority', { data: { priority } })
  expect(res.ok()).toBeTruthy()
}

const isConnectPost = (req) => /\/api\/tenant\/projects\/\d+\/repos$/.test(req.url()) && req.method() === 'POST'

test('metric 3: a fresh tenant is shown their PIN, and the first connect asks only for that PIN', async ({ browser, request }) => {
  const context = await browser.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } })
  await context.addCookies([{ name: 'horizon_session', value: tenant.token, url: BASE_URL }])
  const page = await context.newPage()
  const githubHits = []
  await page.route(/^https?:\/\/(?:[a-z0-9-]+\.)?github\.com\//i, (route) => {
    githubHits.push(route.request().url())
    route.abort('failed')
  })
  const errors = []
  page.on('pageerror', (err) => errors.push(err.message))
  try {
    const before = await (await context.request.get('/api/auth/me')).json()
    expect(before.user.gatePinRevealPending).toBe(true)
    expect(before.user).not.toHaveProperty('pin')

    // The PIN, shown once on the first-project screen.
    await page.goto('/')
    await expect(page.getByRole('heading', { name: HEADING })).toBeVisible()
    const panel = page.getByRole('region', { name: 'Your gate PIN' })
    await expect(panel).toBeVisible()
    const create = page.getByRole('button', { name: 'Create project' })
    await expect(create).toBeDisabled()
    const revealed = page.waitForResponse((res) => res.url().endsWith('/api/auth/gate-pin/first'))
    await panel.getByRole('button', { name: 'Show my PIN' }).click()
    expect((await revealed).status()).toBe(200)
    const pin = await panel.getByLabel('Gate PIN').inputValue()
    expect(pin).toMatch(/^\d{6}$/)
    await panel.getByLabel('I have saved my PIN').check()
    await page.getByLabel('Project name').fill(PROJECT)
    await create.click()
    await expect(page.getByRole('heading', { name: CARD })).toBeVisible()
    const projectId = projectIdOf(PROJECT)

    // The connect: the first POST is the real server's PIN 401; the retried
    // one, with the PIN, is checked by the real server, then answered.
    const retried = []
    await page.route(CONNECT_ROUTE, async (route) => {
      const req = route.request()
      const sentPin = req.headers()['x-human-key']
      if (req.method() !== 'POST' || !sentPin) return route.fallback()
      expect(req.postDataJSON()).toEqual({ repo: REPO, token: TOKEN })
      const real = await route.fetch({ postData: JSON.stringify({ repo: REPO, token: CLASSIC_TOKEN }) })
      retried.push({ sentPin, status: real.status(), body: await real.json() })
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          repo: REPO,
          prefix: 'EFP',
          defaultBranch: 'main',
          githubTokenRef: `file:/etc/horizon/tenant-tokens/${projectId}`,
          runUser: `hz-p${projectId}`,
          webhook: { status: 'ok', lastResponseCode: null, reason: null },
        }),
      })
    })
    const firstAnswer = page.waitForResponse((res) => isConnectPost(res.request()) && !res.request().headers()['x-human-key'])
    await page.getByLabel('Repository', { exact: true }).fill(REPO)
    await page.getByLabel('Token', { exact: true }).fill(TOKEN)
    await page.getByRole('button', { name: 'Connect repository' }).click()
    const first = await firstAnswer
    expect(first.status()).toBe(401)
    expect((await first.json()).error).not.toBe('login_required')

    const dialog = page.getByRole('dialog', { name: 'Enter your gate PIN' })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Gate PIN').fill(pin)
    await dialog.getByRole('button', { name: 'Continue' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('heading', { name: CONNECTED })).toBeVisible()
    // The real server took the shown PIN: past the PIN check to the token check.
    expect(retried).toHaveLength(1)
    expect(retried[0].sentPin).toBe(pin)
    expect(retried[0].status).toBe(400)
    expect(retried[0].body.error).toBe('token_too_broad')
    const verified = await (await context.request.get('/api/auth/me')).json()
    expect(verified.user.pinVerifiedUntil).toBeTruthy()
    expect(verified.user.gatePinRevealPending).toBe(false)
    expect(verified.user).not.toHaveProperty('pin')

    // The real connect's repo row, then a real frame and a reload.
    const db = openDb(DB_PATH)
    try {
      db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(projectId, REPO, 'EFP')
      seededRepos.push(REPO)
    } finally {
      db.close()
    }
    await triggerFrame(request)
    await expect(page.getByRole('button', { name: '+ New work item' })).toBeEnabled({ timeout: 5000 })
    await expect(page.getByRole('heading', { name: CONNECTED })).toBeVisible()

    await page.reload()
    await expect(page.locator('.board__title')).toBeVisible()
    await expect(page.getByRole('heading', { name: CARD })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: HEADING })).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Your gate PIN' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '+ New work item' })).toBeEnabled()
    expect(errors).toEqual([])
    expect(githubHits).toEqual([])
  } finally {
    await context.close()
  }
})
