// HZ-216: while Accept the code runs its pre-merge checks, the gate says so
// and its buttons are disabled — and that state is the server's, so it
// survives a reload. When the run ends, the result is on the gate and the
// buttons come back (a blocked run re-enables them).
//
// Same set-up as 20-premerge-checks.spec.js: only GitHub's answer is canned;
// the real `python -m farm.premerge` and the real `npm test` run inside the
// e2e server's own FARM_HOME. The PR's test sleeps a few seconds before it
// fails, which is the window the reload lands in.

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
const GATE_PIN = '730519'
const REPO = 'e2e-fixture/gate-in-flight'
const PR = 602

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()

// main: a passing test. The PR: the same test, now sleeping, then failing.
function buildRepoHub() {
  const fixture = join(FARM_HOME, 'fixture-gate-in-flight')
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
  git(seed, 'checkout', '-q', '-b', 'horizon/gif-1')
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
      id: 'GIF-1',
      title: 'E2E fixture — Accept the code while its checks run',
      priority: 'High',
      cursor: ACCEPT_GATE_INDEX,
      repo: REPO,
      pr: PR,
      pr_url: `https://github.com/${REPO}/pull/${PR}`,
    })
    // HZ-304: the farm runs only commands saved for the repo, never a guess
    // from package.json. A disabled project, so no board or filter spec sees it.
    const project = insertProject(db, { name: 'E2E Gate In Flight Fixture', enabled: false })
    db.prepare("INSERT INTO project_repo (project_id, repo, prefix, check_test) VALUES (?, ?, 'EGF', 'npm test')").run(project, REPO)
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

test('Accept disables the gate while the checks run, across a reload, until the result is in', async ({ page, request }) => {
  test.setTimeout(90_000)
  const canned = await request.post('/api/test/github-pr', {
    data: { pr: { repo: REPO, pr: PR, headSha: shas.headSha, headRef: 'horizon/gif-1', baseRef: 'main', baseSha: shas.baseSha } },
  })
  expect(canned.ok()).toBeTruthy()

  await page.goto('/gif-1')
  const gate = page.locator('.step-card--awaiting', { hasText: 'Accept the code' })
  const approve = gate.locator('.btn-gate-approve')
  const status = gate.locator('.gate-action-status')
  await expect(approve).toBeEnabled({ timeout: 10_000 })
  await page.evaluate(() => localStorage.removeItem('horizon_gate_pin'))

  await approve.click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  page.once('dialog', (dialog) => dialog.accept(GATE_PIN))
  await page.locator('.composer__submit').click()

  await expect(status).toContainText(`Merging: running checks on main + PR #${PR}`, { timeout: 15_000 })
  await expect(approve).toBeDisabled()
  await expect(gate.locator('.btn-gate-reject')).toBeDisabled()

  // The state is the server's: a fresh page load shows the same run.
  await page.reload()
  await expect(status).toContainText(`Merging: running checks on main + PR #${PR}`, { timeout: 10_000 })
  await expect(approve).toBeDisabled()

  // The run ends red: the gate names the check and opens again.
  await expect(status).toContainText('Blocked: pre-merge check', { timeout: 60_000 })
  await expect(status).not.toContainText('not ok 1')
  await expect(approve).toBeEnabled()
  await captureScreenshot(page, 'gate-in-flight-blocked')
})
