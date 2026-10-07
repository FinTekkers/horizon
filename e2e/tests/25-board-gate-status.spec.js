// HZ-226: Approve on a Board card at Accept the code — the card itself shows
// the background run ("Merging: …") in place of its gate buttons, without a
// reload or navigation, then gets its buttons back with the result.
//
// Same set-up as 21-gate-in-flight.spec.js: only GitHub's answer is canned;
// the real pre-merge checks run inside the e2e server's own FARM_HOME against
// a local bare repo whose PR test sleeps, then fails — so the run ends
// blocked and nothing is ever merged.

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject, setGatePinDirect } from '../fixtures/seed.js'
import { ACCEPT_GATE_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const FARM_HOME = process.env.HORIZON_E2E_FARM_HOME
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '604127'
const REPO = 'e2e-fixture/board-gate-status'
const PR = 603
const TITLE = 'E2E fixture — Board card shows the Accept run'

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()

// main: a passing test. The PR: the same test, now sleeping, then failing.
function buildRepoHub() {
  const fixture = join(FARM_HOME, 'fixture-board-gate-status')
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
  git(seed, 'checkout', '-q', '-b', 'horizon/bgs-1')
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
      id: 'BGS-1',
      title: TITLE,
      priority: 'High',
      cursor: ACCEPT_GATE_INDEX,
      repo: REPO,
      pr: PR,
      pr_url: `https://github.com/${REPO}/pull/${PR}`,
    })
    // HZ-304: the farm runs only commands saved for the repo, never a guess
    // from package.json. A disabled project, so no board or filter spec sees it.
    const project = insertProject(db, { name: 'E2E Board Gate Status Fixture', enabled: false })
    db.prepare("INSERT INTO project_repo (project_id, repo, prefix, check_test) VALUES (?, ?, 'EBG', 'npm test')").run(project, REPO)
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

test('Approve on a Board card at Accept shows the run on the card, with no reload', async ({ page, request }) => {
  test.setTimeout(90_000)
  const canned = await request.post('/api/test/github-pr', {
    data: { pr: { repo: REPO, pr: PR, headSha: shas.headSha, headRef: 'horizon/bgs-1', baseRef: 'main', baseSha: shas.baseSha } },
  })
  expect(canned.ok()).toBeTruthy()

  await page.goto('/')
  const card = page.locator('.card', { hasText: TITLE })
  const approve = card.locator('.btn-approve')
  const status = card.locator('.gate-action-status')
  await expect(approve).toBeVisible({ timeout: 10_000 })
  await page.evaluate(() => localStorage.removeItem('horizon_gate_pin'))

  // Count main-frame navigations from here on: the card must update in place.
  let navigations = 0
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations += 1
  })

  await approve.click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  page.once('dialog', (dialog) => dialog.accept(GATE_PIN))
  await page.locator('.composer__submit').click()

  await expect(status).toContainText('Merging:', { timeout: 5_000 })
  await expect(status).toHaveAttribute('role', 'status')
  await expect(card.locator('.btn-approve')).toHaveCount(0)
  await expect(card.locator('.btn-reject')).toHaveCount(0)
  expect(navigations).toBe(0)
  await captureScreenshot(page, 'board-gate-status-running')

  // The run ends red: the card names the check and its buttons come back.
  await expect(status).toContainText('Blocked: pre-merge check', { timeout: 60_000 })
  await expect(approve).toBeVisible()
  await expect(card.locator('.btn-reject')).toBeVisible()
  expect(navigations).toBe(0)
})
