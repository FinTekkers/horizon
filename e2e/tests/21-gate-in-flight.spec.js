// HZ-216, HZ-226, HZ-279: Accept the code, clicked once on a Board card, starts
// the pre-merge checks in the background. While they run:
//   - the card shows the run ("Merging: …") in place of its gate buttons,
//     without a reload or navigation (HZ-226);
//   - the item page, open in a second tab, says so and disables its gate
//     buttons (HZ-216);
//   - the item is not waiting on anyone, so it leaves the pending-approvals
//     drawer and the top bar's count (HZ-279).
// That state is the server's, so it survives a reload of both tabs. When the
// run ends blocked, the result is on the card and the gate, the buttons come
// back and the item is pending again.
//
// Same set-up as 20-premerge-checks.spec.js: only GitHub's answer is canned;
// the real `python -m farm.premerge` and the real `npm test` run inside the
// e2e server's own FARM_HOME. The PR's test sleeps a few seconds before it
// fails, which is the window the checks and the reload land in — so the
// time-sensitive "Merging" checks come first in each phase.

import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test, expect, answerPinDialog, verifySharedSession } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject, insertGateAction, setGatePinDirect } from '../fixtures/seed.js'
import { ACCEPT_GATE_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const FARM_HOME = process.env.HORIZON_E2E_FARM_HOME
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '730519'
const REPO = 'e2e-fixture/accept-in-flight'
const PR = 621
const ID = 'AIF-1'
const TITLE = 'E2E fixture — Accept the code while its checks run'
const MERGING = `Merging: running checks on main + PR #${PR}`
const WEBHOOK_SECRET = process.env.HORIZON_E2E_GITHUB_WEBHOOK_SECRET

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()

// main: a passing test. The PR: the same test, now sleeping, then failing.
// HO-822's PR (horizon/aif-3) sleeps far longer, so only a cancel ends it.
function buildRepoHub() {
  const fixture = join(FARM_HOME, 'fixture-accept-in-flight')
  const seed = join(fixture, 'seed')
  const origin = join(fixture, 'origin.git')
  const hub = join(FARM_HOME, 'workspaces', REPO.replace('/', '__'))
  rmSync(fixture, { recursive: true, force: true })
  rmSync(hub, { recursive: true, force: true })
  mkdirSync(seed, { recursive: true })
  git(seed, 'init', '-q', '-b', 'main')
  writeFileSync(join(seed, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node test.js' } }))
  writeFileSync(join(seed, 'test.js'), "console.log('ok 1 - fixture')\n")
  git(seed, 'add', '-A')
  git(seed, 'commit', '-q', '-m', 'green main')
  const baseSha = git(seed, 'rev-parse', 'HEAD')
  git(seed, 'checkout', '-q', '-b', 'horizon/aif-1')
  writeFileSync(
    join(seed, 'test.js'),
    "setTimeout(() => { console.log('not ok 1 - slow and red'); process.exit(1) }, 6000)\n",
  )
  git(seed, 'commit', '-q', '-am', 'PR: a slow red test')
  const headSha = git(seed, 'rev-parse', 'HEAD')
  git(seed, 'checkout', '-q', '-b', 'horizon/aif-3', baseSha)
  writeFileSync(
    join(seed, 'test.js'),
    "setTimeout(() => { console.log('not ok 1 - never cancelled'); process.exit(1) }, 120000)\n",
  )
  git(seed, 'commit', '-q', '-am', 'PR: a test that outlives the merge')
  const slowHeadSha = git(seed, 'rev-parse', 'HEAD')
  execFileSync('git', ['clone', '-q', '--bare', seed, origin])
  mkdirSync(join(FARM_HOME, 'workspaces'), { recursive: true })
  execFileSync('git', ['clone', '-q', origin, hub])
  return { baseSha, headSha, slowHeadSha }
}

let shas

test.beforeAll(() => {
  expect(FARM_HOME, 'playwright.config.js must give the e2e server its own FARM_HOME').toBeTruthy()
  expect(FARM_HOME.startsWith(join(homedir(), '.horizon-farm'))).toBe(false)
  shas = buildRepoHub()
  const db = openDb(DB_PATH)
  try {
    insertItem(db, {
      id: ID,
      title: TITLE,
      priority: 'High',
      cursor: ACCEPT_GATE_INDEX,
      repo: REPO,
      pr: PR,
      pr_url: `https://github.com/${REPO}/pull/${PR}`,
    })
    // HZ-304: the farm runs only commands saved for the repo, never a guess
    // from package.json. A disabled project, so no board or filter spec sees it.
    const project = insertProject(db, { name: 'E2E Accept In Flight Fixture', enabled: false })
    db.prepare("INSERT INTO project_repo (project_id, repo, prefix, check_test) VALUES (?, ?, 'EAF', 'npm test')").run(project, REPO)
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

test('Accept on a Board card shows the run on the card and the gate, and takes the item out of pending, across a reload, until the result is in', async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(90_000)
  const canned = await request.post('/api/test/github-pr', {
    data: { pr: { repo: REPO, pr: PR, headSha: shas.headSha, headRef: 'horizon/aif-1', baseRef: 'main', baseSha: shas.baseSha } },
  })
  expect(canned.ok()).toBeTruthy()

  // Tab 1: the Board, where Accept is clicked.
  await page.goto('/')
  const card = page.locator('.card', { hasText: TITLE })
  const cardApprove = card.locator('.btn-approve')
  // HZ-711: the card's ⋯ menu (Return to…, Abandon) replaced Send back.
  const cardReject = card.getByRole('button', { name: `More actions for ${ID}` })
  const cardStatus = card.locator('.gate-action-status')
  const badge = page.locator('.topbar .pending-btn__badge')
  const drawerItem = page.locator('.drawer .approval', { hasText: ID })
  const openDrawer = () => page.getByRole('button', { name: /Pending approvals/ }).click()
  const closeDrawer = () => page.locator('.drawer__close').click()
  await expect(cardApprove).toBeVisible({ timeout: 10_000 })

  // Tab 2: the item page, open before the click so its update is live.
  const itemPage = await context.newPage()
  await itemPage.goto(`/${ID.toLowerCase()}`)
  const gate = itemPage.locator('.step-card--awaiting', { hasText: 'Accept the code' })
  const gateApprove = gate.locator('.btn-gate-approve')
  const gateReject = gate.getByRole('button', { name: 'Return to…' })
  const gateStatus = gate.locator('.gate-action-status')
  await expect(gateApprove).toBeEnabled({ timeout: 10_000 })

  await openDrawer()
  await expect(drawerItem).toHaveCount(1)
  await closeDrawer()
  const pending = Number(await badge.textContent())
  expect(pending).toBeGreaterThan(0)

  // Count main-frame navigations from here on: the card must update in place.
  let navigations = 0
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations += 1
  })

  await cardApprove.click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  await page.locator('.composer__submit').click()
  // beforeAll's setGatePinDirect locked the session (HZ-704): Accept asks once.
  await answerPinDialog(page, GATE_PIN)

  // Checks on both tabs while the run is in flight. The "Merging" text is a
  // hard expect: if the result lands first, this fails rather than skips.
  async function expectInFlight(timeout) {
    await expect(cardStatus).toContainText('Merging:', { timeout })
    await expect(gateStatus).toContainText(MERGING, { timeout })
    await expect(gateApprove).toBeDisabled()
    await expect(gateReject).toBeDisabled()
    await expect(cardStatus).toHaveAttribute('role', 'status')
    await expect(cardApprove).toHaveCount(0)
    await expect(cardReject).toHaveCount(0)
    await expect(badge).toHaveText(String(pending - 1))
    await openDrawer()
    await expect(drawerItem).toHaveCount(0)
    await closeDrawer()
  }

  await expectInFlight(15_000)
  expect(navigations).toBe(0)

  // The state is the server's: a fresh load of both tabs shows the same run.
  await Promise.all([page.reload(), itemPage.reload()])
  navigations = 0
  await expectInFlight(10_000)

  // The run ends red: the card and the gate name the check, their buttons
  // come back, and the item is waiting on the owner again.
  await expect(cardStatus).toContainText('Blocked: pre-merge check', { timeout: 60_000 })
  await expect(cardApprove).toBeVisible()
  await expect(cardReject).toBeVisible()
  await expect(badge).toHaveText(String(pending))
  await openDrawer()
  await expect(drawerItem).toHaveCount(1)
  await closeDrawer()
  expect(navigations).toBe(0)

  await expect(gateStatus).toContainText('Blocked: pre-merge check')
  await expect(gateStatus).not.toContainText('not ok 1')
  await expect(gateApprove).toBeEnabled()
})

// HZ-585: an Accept whose pre-merge run is queued for a capacity slot says so on
// the gate, with how many runs started waiting first, and a reload shows the
// same — it is the server's gate_action row. Seeded as a running row: the
// live queue itself is proven in server/test/premerge-slot-queue-live.test.mjs.
test('a pre-merge run queued for a capacity slot shows what it waits for, 1 ahead, on the gate, across a reload', async ({ page }) => {
  const id = 'AIF-2'
  const queuedTitle = 'E2E fixture — Accept queued for a capacity slot'
  const db = openDb(DB_PATH)
  try {
    insertItem(db, {
      id,
      title: queuedTitle,
      priority: 'High',
      cursor: ACCEPT_GATE_INDEX,
      repo: REPO,
      pr: PR + 1,
      pr_url: `https://github.com/${REPO}/pull/${PR + 1}`,
    })
    insertGateAction(db, { itemId: id, state: 'running', detail: 'waiting for a capacity slot to run pre-merge checks (main + PR), 1 ahead' })
  } finally {
    db.close()
  }
  const QUEUED = 'Merging: waiting for a capacity slot to run pre-merge checks (main + PR), 1 ahead'
  await page.goto(`/${id.toLowerCase()}`)
  const gate = page.locator('.step-card--awaiting', { hasText: 'Accept the code' })
  await expect(gate.getByText(QUEUED)).toBeVisible({ timeout: 10_000 })
  await expect(gate.locator('.btn-gate-approve')).toBeDisabled()
  await page.reload()
  await expect(gate.getByText(QUEUED)).toBeVisible({ timeout: 10_000 })
})

// HO-822: the owner clicks Accept on the Board card, then merges the PR on
// GitHub while its pre-merge check is still running. GitHub's "merged"
// webhook — signed, through the real route — stops that check: the Accept
// request answers 200 { ok: true, superseded: true }, the card leaves
// "Merging", no error shows, and the item reaches "Review the work & close",
// which approves at once and closes the item. A reload keeps all of it: it is
// the server's state. The kill itself is proven in
// server/test/premerge-pr-merged-live.test.mjs; this is the owner's path.
test('a PR merged on GitHub while Accept runs its checks stops them; the Accept answers, and the next gate approves at once, across a reload', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000)
  expect(WEBHOOK_SECRET, 'playwright.config.js must give the e2e server a webhook secret').toBeTruthy()
  const id = 'AIF-3'
  const pr = PR + 2
  const mergedTitle = 'E2E fixture — PR merged on GitHub while Accept runs'
  const db = openDb(DB_PATH)
  try {
    insertItem(db, {
      id,
      title: mergedTitle,
      priority: 'High',
      cursor: ACCEPT_GATE_INDEX,
      repo: REPO,
      pr,
      pr_url: `https://github.com/${REPO}/pull/${pr}`,
    })
  } finally {
    db.close()
  }
  const canned = await request.post('/api/test/github-pr', {
    data: { pr: { repo: REPO, pr, headSha: shas.slowHeadSha, headRef: 'horizon/aif-3', baseRef: 'main', baseSha: shas.baseSha } },
  })
  expect(canned.ok()).toBeTruthy()
  // The shared session may be locked (beforeAll's setGatePinDirect) or already
  // verified by the test above: verify it here, so no PIN dialog either way.
  await verifySharedSession(GATE_PIN)

  await page.goto('/')
  const card = page.locator('.card', { hasText: mergedTitle })
  const cardApprove = card.locator('.btn-approve')
  const cardStatus = card.locator('.gate-action-status')
  await expect(cardApprove).toBeVisible({ timeout: 10_000 })

  const acceptAnswer = page.waitForResponse(
    (res) => res.request().method() === 'POST' && res.url().endsWith(`/api/items/${id}/move`),
    { timeout: 30_000 },
  )
  await cardApprove.click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  await page.locator('.composer__submit').click()
  await expect(cardStatus).toContainText('Merging:', { timeout: 15_000 })

  // The owner merges on GitHub. GitHub tells Horizon with a signed webhook.
  const body = JSON.stringify({
    action: 'closed',
    repository: { full_name: REPO },
    pull_request: { number: pr, merged: true, state: 'closed' },
  })
  const signature = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')
  const merged = await request.post('/api/webhooks/github', {
    data: body,
    headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-hub-signature-256': signature },
  })
  expect(merged.status()).toBe(204)

  // The waiting Accept answers now — not when the 120 s test would end.
  const answer = await acceptAnswer
  expect(answer.status()).toBe(200)
  // The /move route also names the move that happened: GitHub's, not this one.
  const answered = await answer.json()
  expect(answered).toMatchObject({ ok: true, superseded: true })
  expect(answered.move).toMatchObject({ who: 'GitHub', fromKey: 'change.accept-code' })
  await expect(card.getByText('Merging:')).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)

  // The item page: Accept is done, nothing is "Merging", and the next gate is
  // the owner's to approve — before and after a reload.
  await page.goto(`/${id.toLowerCase()}`)
  const nextGate = page.locator('.step-card--awaiting', { hasText: 'Review the work & close' })
  const nextApprove = nextGate.locator('.btn-gate-approve')
  async function expectNextGateOpen() {
    await expect(nextApprove).toBeEnabled({ timeout: 15_000 })
    await expect(page.getByText(/Merging:/)).toHaveCount(0)
  }
  await expectNextGateOpen()
  await page.reload()
  await expectNextGateOpen()

  // Approving it closes the item and returns to the Board (HZ-62).
  await nextApprove.click()
  await expect(page.locator('.composer__sub')).toContainText('Review the work & close')
  await page.locator('.composer__submit').click()
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 })

  // GitHub merged it; Horizon never merged it a second time.
  const eventsDb = openDb(DB_PATH)
  let texts
  try {
    texts = eventsDb.prepare('SELECT text FROM event WHERE item_id = ?').all(id).map((e) => e.text)
  } finally {
    eventsDb.close()
  }
  expect(texts.filter((t) => t === `PR #${pr} was merged on GitHub — code accepted`)).toHaveLength(1)
  expect(texts.filter((t) => t.includes(`merged PR #${pr}`))).toHaveLength(0)
})
