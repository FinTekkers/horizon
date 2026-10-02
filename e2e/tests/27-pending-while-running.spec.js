// HZ-279: once Accept is clicked the item is not waiting on anyone, so it
// leaves the pending-approvals drawer and the top bar's count while its
// pre-merge checks run — across a reload, because the state is the server's —
// and comes back when the run ends blocked.
//
// Same set-up as 21-gate-in-flight.spec.js, with its own item, repo and PR:
// only GitHub's answer is canned; the real `python -m farm.premerge` and the
// real `npm test` run inside the e2e server's own FARM_HOME. The PR's test
// sleeps a few seconds before it fails, which is the window the reload lands
// in.

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, setGatePinDirect } from '../fixtures/seed.js'
import { ACCEPT_GATE_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const FARM_HOME = process.env.HORIZON_E2E_FARM_HOME
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '730527'
const REPO = 'e2e-fixture/pending-while-running'
const PR = 627

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()

// main: a passing test. The PR: the same test, now sleeping, then failing.
function buildRepoHub() {
  const fixture = join(FARM_HOME, 'fixture-pending-while-running')
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
  git(seed, 'checkout', '-q', '-b', 'horizon/pwr-1')
  writeFileSync(
    join(seed, 'test.js'),
    "setTimeout(() => { console.log('not ok 1 - slow and red'); process.exit(1) }, 6000)\n",
  )
  git(seed, 'commit', '-q', '-am', 'PR: a slow red test')
  const headSha = git(seed, 'rev-parse', 'HEAD')
  execFileSync('git', ['clone', '-q', '--bare', seed, origin])
  mkdirSync(join(FARM_HOME, 'workspaces'), { recursive: true })
  execFileSync('git', ['clone', '-q', origin, hub])
  return { baseSha, headSha }
}

let shas

test.beforeAll(() => {
  expect(FARM_HOME, 'playwright.config.js must give the e2e server its own FARM_HOME').toBeTruthy()
  expect(FARM_HOME.startsWith(join(homedir(), '.horizon-farm'))).toBe(false)
  shas = buildRepoHub()
  const db = openDb(DB_PATH)
  try {
    insertItem(db, {
      id: 'PWR-1',
      title: 'E2E fixture — leaves pending approvals while Accept runs',
      priority: 'High',
      cursor: ACCEPT_GATE_INDEX,
      repo: REPO,
      pr: PR,
      pr_url: `https://github.com/${REPO}/pull/${PR}`,
    })
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

test('Accept takes the item out of pending approvals while it runs, across a reload, until it ends blocked', async ({ page, request }) => {
  test.setTimeout(90_000)
  const canned = await request.post('/api/test/github-pr', {
    data: { pr: { repo: REPO, pr: PR, headSha: shas.headSha, headRef: 'horizon/pwr-1', baseRef: 'main', baseSha: shas.baseSha } },
  })
  expect(canned.ok()).toBeTruthy()

  await page.goto('/pwr-1')
  const gate = page.locator('.step-card--awaiting', { hasText: 'Accept the code' })
  const approve = gate.locator('.btn-gate-approve')
  const status = gate.locator('.gate-action-status')
  const badge = page.locator('.topbar .pending-btn__badge')
  const drawerItem = page.locator('.drawer .approval', { hasText: 'PWR-1' })
  const openDrawer = () => page.getByRole('button', { name: /Pending approvals/ }).click()
  const closeDrawer = () => page.locator('.drawer__close').click()
  await expect(approve).toBeEnabled({ timeout: 10_000 })

  await openDrawer()
  await expect(drawerItem).toHaveCount(1)
  const pending = Number(await badge.textContent())
  expect(pending).toBeGreaterThan(0)
  await closeDrawer()
  await page.evaluate(() => localStorage.removeItem('horizon_gate_pin'))

  await approve.click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  page.once('dialog', (dialog) => dialog.accept(GATE_PIN))
  await page.locator('.composer__submit').click()

  await expect(status).toContainText(`Merging: running checks on main + PR #${PR}`, { timeout: 15_000 })
  await expect(badge).toHaveText(String(pending - 1))
  await openDrawer()
  await expect(drawerItem).toHaveCount(0)
  await closeDrawer()

  // The state is the server's: a fresh page load still does not count it.
  await page.reload()
  await expect(status).toContainText(`Merging: running checks on main + PR #${PR}`, { timeout: 10_000 })
  await expect(badge).toHaveText(String(pending - 1))
  await openDrawer()
  await expect(drawerItem).toHaveCount(0)
  await closeDrawer()

  // The run ends red: the item is waiting on the owner again.
  await expect(status).toContainText('Blocked: pre-merge check', { timeout: 60_000 })
  await expect(badge).toHaveText(String(pending))
  await openDrawer()
  await expect(drawerItem).toHaveCount(1)
  await captureScreenshot(page, 'pending-while-running-blocked')
})
