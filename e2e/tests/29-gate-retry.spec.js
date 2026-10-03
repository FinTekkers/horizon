// HZ-231: an Accept run that timed out shows Retry beside its reason on the
// Board card. The failure is the server's, so a reload keeps it. Retry is
// Accept relabelled — the same confirm dialog and PIN prompt — and the card
// moves to the running status, which replaces the old reason.
//
// Same set-up as 21-gate-in-flight.spec.js: only GitHub's answer is canned;
// the real `python -m farm.premerge` and the real `npm test` run inside the
// e2e server's own FARM_HOME. The PR's test sleeps long enough that the
// running status is reliably on screen.

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, insertGateAction, setGatePinDirect } from '../fixtures/seed.js'
import { ACCEPT_GATE_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const FARM_HOME = process.env.HORIZON_E2E_FARM_HOME
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '730519'
const REPO = 'e2e-fixture/gate-retry'
const PR = 629
const REASON = 'pre-merge checks did not finish: timed out'

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()

// main: a passing test. The PR: the same test, now slow, then failing.
function buildRepoHub() {
  const fixture = join(FARM_HOME, 'fixture-gate-retry')
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
  git(seed, 'checkout', '-q', '-b', 'horizon/grt-1')
  writeFileSync(
    join(seed, 'test.js'),
    "setTimeout(() => { console.log('not ok 1 - slow and red'); process.exit(1) }, 10000)\n",
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
      id: 'GRT-1',
      title: 'E2E fixture — Retry an Accept run that timed out',
      priority: 'High',
      cursor: ACCEPT_GATE_INDEX,
      repo: REPO,
      pr: PR,
      pr_url: `https://github.com/${REPO}/pull/${PR}`,
    })
    insertGateAction(db, { itemId: 'GRT-1', state: 'timed_out', reason: REASON })
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

test('a timed-out Accept run shows Retry on the card; Retry with the PIN starts a new run', async ({ page, request }) => {
  test.setTimeout(90_000)
  const canned = await request.post('/api/test/github-pr', {
    data: { pr: { repo: REPO, pr: PR, headSha: shas.headSha, headRef: 'horizon/grt-1', baseRef: 'main', baseSha: shas.baseSha } },
  })
  expect(canned.ok()).toBeTruthy()

  await page.goto('/')
  const card = page.locator('.card', { hasText: 'GRT-1' })
  const status = card.locator('.gate-action-status')
  const retry = status.getByRole('button', { name: 'Retry' })
  await expect(status).toContainText('Checks did not finish', { timeout: 10_000 })
  await expect(status).toContainText(REASON)
  await expect(retry).toBeEnabled()

  // The failure is the server's: a fresh page load keeps it.
  await page.reload()
  await expect(status).toContainText('Checks did not finish', { timeout: 10_000 })
  await expect(status).toContainText(REASON)
  await expect(retry).toBeEnabled()

  await page.evaluate(() => localStorage.removeItem('horizon_gate_pin'))
  await retry.click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  page.once('dialog', (dialog) => dialog.accept(GATE_PIN))
  await page.locator('.composer__submit').click()

  await expect(status).toContainText(`Merging: running checks on main + PR #${PR}`, { timeout: 15_000 })
  await expect(status).not.toContainText(REASON)
  await expect(retry).toHaveCount(0)
})
