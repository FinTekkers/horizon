// HZ-183: Accept the code runs the repo's checks on a test-merge of the PR
// into the current base before it merges — from the human's side. A PR whose
// own test fails on the merge is refused: the gate stays open, nothing is
// merged, no GitHub tab is opened, and the activity log names the failing
// check with the LAST lines of its output, where the failing test is.
//
// Only GitHub's answer is canned (/api/test/github-pr: which head and base to
// test). The click, the confirm dialog, the PIN, the real `python -m
// farm.premerge` run, the real git merge and the real `npm test` all run as in
// production — inside the e2e server's own throwaway FARM_HOME
// (playwright.config.js), where this spec builds the repo hub. Nothing here,
// nor in the server it drives, can reach the farm's ~/.horizon-farm.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject, setGatePinDirect } from '../fixtures/seed.js'
import { ACCEPT_GATE_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const FARM_HOME = process.env.HORIZON_E2E_FARM_HOME
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '730519'
const REPO = 'e2e-fixture/premerge-red'
const PR = 601

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()

// main: a passing test. The PR: the same test, now printing 60 lines and
// failing on the last — so only a tail cut from the END names it.
function buildRepoHub() {
  const fixture = join(FARM_HOME, 'fixture')
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
  git(seed, 'checkout', '-q', '-b', 'horizon/pmc-1')
  writeFileSync(
    join(seed, 'test.js'),
    "for (let i = 1; i <= 60; i++) console.log(`fixture-line-${String(i).padStart(2, '0')}`)\n" +
      "console.log('not ok 1 - the PR breaks test_premerge_fixture')\nprocess.exit(1)\n",
  )
  git(seed, 'commit', '-q', '-am', 'PR: break the test')
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
      id: 'PMC-1',
      title: 'E2E fixture — PR that turns the test-merge red',
      priority: 'High',
      cursor: ACCEPT_GATE_INDEX,
      repo: REPO,
      pr: PR,
      pr_url: `https://github.com/${REPO}/pull/${PR}`,
    })
    // HZ-304: the farm runs only commands saved for the repo, never a guess
    // from package.json — so the fixture repo is connected with its test
    // command. A disabled project, so no board or filter spec sees it.
    const project = insertProject(db, { name: 'E2E Premerge Fixture', enabled: false })
    db.prepare("INSERT INTO project_repo (project_id, repo, prefix, check_test) VALUES (?, ?, 'EPM', 'npm test')").run(project, REPO)
    // 10-gate-key.spec.js rewrites the account's PIN directly in the DB, so
    // this spec sets its own and answers the prompt, like that one does.
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

test('a red check on the test-merge keeps Accept the code open and names the failing check', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000)
  const canned = await request.post('/api/test/github-pr', {
    data: { pr: { repo: REPO, pr: PR, headSha: shas.headSha, headRef: 'horizon/pmc-1', baseRef: 'main', baseSha: shas.baseSha } },
  })
  expect(canned.ok()).toBeTruthy()

  const approves = []
  page.on('response', (res) => {
    if (res.url().includes('/gates/') && res.url().endsWith('/approve')) approves.push(res.status())
  })

  await page.goto('/pmc-1')
  const gate = page.locator('.step-card--awaiting', { hasText: 'Accept the code' })
  await expect(gate.locator('.btn-gate-approve')).toBeVisible({ timeout: 10_000 })
  await page.evaluate(() => localStorage.removeItem('horizon_gate_pin'))

  await gate.locator('.btn-gate-approve').click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  page.once('dialog', (dialog) => dialog.accept(GATE_PIN))
  await page.locator('.composer__submit').click()

  // Told it's running before it finishes, so nobody clicks again.
  const activity = page.locator('.tracker__activity')
  await expect(activity).toContainText(`running the repo's checks on a test-merge of main + PR #${PR}`, {
    timeout: 15_000,
  })

  await expect(activity).toContainText('pre-merge checks failed', { timeout: 60_000 })
  await expect(activity).toContainText(`PR #${PR} is not merged and the gate stays open`)
  await expect(activity).toContainText('npm test --silent')
  await expect(activity).toContainText('not ok 1 - the PR breaks test_premerge_fixture')
  await expect(activity).toContainText('fixture-line-60')
  await expect(activity).not.toContainText('fixture-line-01')
  await expect(activity).not.toContainText(`merged PR #${PR}`)
  expect(approves).toEqual([502])

  // Still the human's gate, and the failure did not send them to GitHub.
  await expect(gate.locator('.btn-gate-approve')).toBeVisible()
  expect(page.context().pages()).toHaveLength(1)

  // The run happened in the e2e server's FARM_HOME, and its scratch
  // worktree was reaped.
  const premergeRoot = join(FARM_HOME, 'workspaces', `${REPO.replace('/', '__')}__premerge`)
  expect(existsSync(premergeRoot)).toBe(true)
  expect(existsSync(join(premergeRoot, 'pmc-1'))).toBe(false)

  await activity
    .locator('.activity-row', { hasText: 'pre-merge checks failed' })
    .evaluate((row) => row.scrollIntoView({ block: 'start' }))
  await captureScreenshot(page, 'premerge-checks-red')
})
