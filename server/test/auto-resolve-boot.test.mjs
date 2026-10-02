// HZ-255: every boot queues one auto-resolve scan per connected repo, through
// the same debounce and queue as a main move — so a merge whose release deploy
// restarted the server inside the debounce window is still scanned. The
// debounce runs on node:test's fake setTimeout: no test waits real time.

import { test, beforeEach, afterEach, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { setupAutoResolve, REPO } from './helpers/autoResolveHarness.mjs'

const h = await setupAutoResolve('auto-resolve-boot')
const { autoResolve, gh, lifecycle, store, settings } = h
const { AUTO_RESOLVE_DEBOUNCE_MS } = await import('../src/config.js')
const { IMPLEMENT_STEP_INDEX, ACCEPT_GATE_INDEX, REVIEW_STEP_INDEX, STEPS } = lifecycle

const REPO_2 = 'acme/auto-resolve-2'
assert.ok(store.addRepoToProject(h.projectId, REPO_2).ok)

const log = { info: (m) => h.lines.push(String(m)), warn: (m) => h.lines.push(String(m)), error: (m) => h.lines.push(String(m)) }

const rejections = []
const onRejection = (err) => rejections.push(err)
process.on('unhandledRejection', onRejection)

beforeEach(() => h.reset())
afterEach(() => mock.timers.reset())
after(() => {
  process.off('unhandledRejection', onRejection)
  rmSync(dirname(process.env.HORIZON_DB), { recursive: true, force: true })
  assert.deepEqual(rejections, [], 'no unhandled promise rejection')
})

// Every connected repo, from the DB — HORIZON_REPO may add a legacy one.
const repos = () => store.listRepos().map((r) => r.repo)
const mainReads = () => gh.calls.filter((c) => /\/git\/ref\/heads%2Fmain$/.test(c.path))
const mainReadsFor = (repo) => mainReads().filter((c) => c.path.startsWith(`/repos/${repo}/`))

// A fresh process start: the in-memory state is gone, the listeners stay.
function boot(opts) {
  autoResolve.resetForTest()
  autoResolve.stopForTest()
  mock.timers.enable({ apis: ['setTimeout'] })
  return autoResolve.startAutoResolve(log, opts)
}

async function fireDebounce() {
  mock.timers.tick(AUTO_RESOLVE_DEBOUNCE_MS)
  mock.timers.reset() // before the scan runs, so its backoff and fetches use real timers
  await autoResolve.whenIdleForTest()
}

test('boot queues one scan per connected repo, fired by the debounce timer', async () => {
  h.insertItem('BT-A', { pr: 901 })
  h.insertItem('BT-B', { pr: 902, repo: REPO_2 })
  boot()

  mock.timers.tick(AUTO_RESOLVE_DEBOUNCE_MS - 1)
  assert.equal(gh.calls.length, 0, 'nothing scanned before the debounce window ends')
  assert.deepEqual(h.itemLines('BT-A'), [])
  mock.timers.tick(1)
  mock.timers.reset()
  await autoResolve.whenIdleForTest()

  assert.ok(repos().length >= 2)
  assert.equal(mainReads().length, repos().length, 'one scan per repo')
  for (const repo of repos()) assert.equal(mainReadsFor(repo).length, 1, `one scan of ${repo}`)
  assert.deepEqual(h.itemLines('BT-A'), [`auto-resolve ${REPO} [main moved: server restarted] BT-A PR #901: clean`])
  assert.deepEqual(h.itemLines('BT-B'), [`auto-resolve ${REPO_2} [main moved: server restarted] BT-B PR #902: clean`])
})

for (const via of ['setting', 'env']) {
  test(`auto-resolve off (${via}): boot scans decide nothing and start no run`, async () => {
    h.conflictedAtGate('BT-OFF-' + via, via === 'setting' ? 911 : 912)
    const saved = process.env.AUTO_RESOLVE_ON_MAIN
    try {
      if (via === 'setting') settings.setSetting('auto_resolve_on_main', '0')
      else process.env.AUTO_RESOLVE_ON_MAIN = '0'
      boot()
      await fireDebounce()
    } finally {
      if (saved === undefined) delete process.env.AUTO_RESOLVE_ON_MAIN
      else process.env.AUTO_RESOLVE_ON_MAIN = saved
    }
    assert.equal(gh.calls.length, 0)
    assert.equal(h.farmCalls.length, 0)
    assert.equal(h.gateAction('BT-OFF-' + via), undefined)
    assert.deepEqual(h.itemLines('BT-OFF-' + via), [])
    for (const repo of repos()) {
      assert.equal(h.lines.filter((l) => l === `auto-resolve off — ignored main move on ${repo}`).length, 1, repo)
    }
  })
}

test('a boot scan covers the merge-scan window: implement through the Accept gate', async () => {
  h.insertItem('BC-IMPL', { cursor: IMPLEMENT_STEP_INDEX })
  h.insertItem('BC-REVIEW', { cursor: REVIEW_STEP_INDEX, pr: 921 })
  h.conflictedAtGate('BC-GATE', 922)
  h.insertItem('BC-EARLY', { cursor: IMPLEMENT_STEP_INDEX - 1 })
  h.farmReplyNext(h.resolved)
  boot()
  await fireDebounce()

  for (const id of ['BC-IMPL', 'BC-REVIEW', 'BC-GATE']) {
    const lines = h.itemLines(id)
    assert.equal(lines.length, 1, id)
    assert.match(lines[0], /\[main moved: server restarted\] /)
  }
  assert.deepEqual(h.itemLines('BC-EARLY'), [])
  assert.equal(h.resolveCallsFor('BC-GATE').length, 1)
  // The run is recorded exactly as a merge-started one.
  assert.equal(h.gateAction('BC-GATE').started_by, 'main_moved')
  assert.ok(
    h.events('BC-GATE').includes('main moved (server restarted) — PR #922 no longer merges cleanly; started Resolve conflicts automatically'),
  )
})

test('an item a scan left waiting gets exactly one line on the next boot', async () => {
  h.insertItem('BW-Y', { cursor: REVIEW_STEP_INDEX, pr: 931 })
  const run = h.startStep('BW-Y', REVIEW_STEP_INDEX)
  await h.mergeWebhook(930)
  await autoResolve.whenIdleForTest()
  assert.ok(autoResolve.waitingForTest().includes('BW-Y'))
  // It moves out of the window while waiting.
  h.db.prepare("UPDATE step_run SET status = 'done' WHERE id = ?").run(run)
  h.db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(STEPS.length, 'BW-Y')
  h.lines.length = 0

  // Boot without reset(): the waiting entry is kept.
  autoResolve.stopForTest()
  mock.timers.enable({ apis: ['setTimeout'] })
  autoResolve.startAutoResolve(log)
  await fireDebounce()
  assert.equal(h.itemLines('BW-Y').length, 1)
  assert.match(h.itemLines('BW-Y')[0], /\[main moved: server restarted\] BW-Y PR #931: skipped/)
})

test('a merge during the boot window joins the boot scan: one scan per repo, the line names the PR', async () => {
  h.conflictedAtGate('BM-Y', 941)
  h.insertItem('BM-Z', { pr: 942, repo: REPO_2 })
  h.farmReplyNext(h.resolved)
  boot()
  await h.mergeWebhook(500)
  await fireDebounce()

  for (const repo of repos()) assert.equal(mainReadsFor(repo).length, 1, `one scan of ${repo}`)
  const y = h.itemLines('BM-Y')
  assert.equal(y.length, 1)
  assert.match(y[0], /\[main moved: merged PR #500\] BM-Y PR #941: /)
  assert.doesNotMatch(y[0], /server restarted/)
  assert.deepEqual(h.itemLines('BM-Z'), [`auto-resolve ${REPO_2} [main moved: server restarted] BM-Z PR #942: clean`])
  assert.equal(h.farmCalls.length, 1)
})

test('startAutoResolve returns synchronously and reads nothing remote before the timer fires', async () => {
  h.conflictedAtGate('BS-Y', 951)
  h.farmReplyNext(h.resolved)
  const result = boot()
  // listRepos() is one sync DB read; no GitHub call and no item scan happen here.
  assert.equal(result, undefined, 'not a promise: startup and the listener are never awaited on it')
  assert.equal(gh.calls.length, 0)
  assert.equal(h.farmCalls.length, 0)
  assert.deepEqual(h.itemLines('BS-Y'), [])
  await fireDebounce()
  assert.equal(h.farmCalls.length, 1)
})

test('a boot scan with no open items logs one "scan ran" line per repo', async () => {
  // Earlier tests' items are moved out of every repo's window.
  h.db.prepare('UPDATE work_item SET cursor = ?').run(STEPS.length)
  boot()
  await fireDebounce()
  for (const repo of repos()) {
    assert.deepEqual(
      h.lines.filter((l) => l.startsWith(`auto-resolve ${repo} `)),
      [`auto-resolve ${repo} [main moved: server restarted]: scan ran, no open items`],
    )
  }
})

test('a boot scan never starts a second run for an item whose run is held', async () => {
  h.insertItem('BL-Y', { pr: 961, mergeable: 0 }) // the button needs a stored conflict
  gh.mergeable.set(961, false)
  const click = h.resolvePost('BL-Y')
  await h.untilFarmCalls(1)
  boot()
  await fireDebounce()
  assert.deepEqual(h.itemLines('BL-Y'), [`auto-resolve ${REPO} [main moved: server restarted] BL-Y PR #961: skipped (lock held)`])
  assert.equal(h.resolveCallsFor('BL-Y').length, 1)

  gh.mergeable.set(961, true)
  h.farmCalls[0].resolve(h.replyOk(h.resolved))
  assert.equal((await click).statusCode, 200)
})

test('a failed repo read is caught and logged; startup carries on', async () => {
  const result = boot({
    listRepos: () => {
      throw new TypeError('/secret/path/horizon.db is locked')
    },
  })
  assert.equal(result, undefined)
  assert.deepEqual(h.lines, ['auto-resolve: boot scan not queued (TypeError)'])
  await autoResolve.whenIdleForTest()
  assert.equal(gh.calls.length, 0)
})
