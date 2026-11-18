// HO-881: the whole `sl` path, end to end, on a scratch project — no GitHub.
//
// One item on a scratch sl project walks, in order:
//   1. Task created     POST /api/items → backends/slTracker.js createIssue →
//                       farmd /api/farm/tasks (farm/task_driver.py's stub driver)
//   2. diff submitted   the registry's submitDiff (the call
//                       orchestrator.completeFarmRun makes for an sl implement
//                       result) → farmd /vcs/submit → `jf submit`
//      then accepted    the reviewer accepts on the fake Phabricator; the
//                       registry's refreshReviewStatus (what the Accept
//                       caretaker reads) → farmd /vcs/review-status → `sl log
//                       -T {phabstatus}` answers Accepted
//   3. diff landed      Accept the code → app.js acceptSl → backends/sl/vcs.js →
//                       farmd /vcs/land → farm/vcs/sl.py land → `sl push`;
//                       store.markLanded records landed_hash
//   4. Task closed      the final gate → slTracker closeIssueWithSummary →
//                       farmd /api/farm/tasks/<n>/close; landed_hash unchanged
// then two more land runs push nothing and leave landed_hash as it was.
//
// What is real: the Fastify app, the server's sl adapters, a real farmd child
// (helpers/slPathFakes.mjs) with farm/vcs/sl.py and its Task routes. What is
// fake: `sl`, `jf`, `eden`, `git` and `gh` (PATH shims over
// helpers/slPath/fake_vcs.py) and the Task service (TASK_DRIVER=stub, the
// farm's own in-memory TaskDriver). Two step moves are DB writes, named where
// they happen: onto Accept the code, and from after it to the final gate. The
// agent steps between are not part of the sl path this item proves.
//
// Why submitDiff and not completeFarmRun: completing the implement step also
// dispatches the item's next agent step. For an sl item that request goes to
// farmd's /steps/run with no `backend`, so farmd treats it as a git step and
// runs `git clone https://github.com/<repo>.git` — which this test's recorders
// caught. That is a gap in the agent-step path, not in the four steps here
// (sl-submit-wiring.test.mjs covers completeFarmRun → submitDiff), and is
// reported on HO-881 rather than hidden: nothing below loosens a zero check.
//
// Every recorder writes one ordered log (<root>/calls.jsonl):
//   - the shims, one line per sl/jf/eden/git/gh run;
//   - farmd's sitecustomize.py, one line per spawn (subprocess.Popen,
//     os.system, os.posix_spawn, os.exec*) and per api.github.com lookup;
//   - this process: every fetch, http.request and https.request, and every
//     child_process spawn. <root>/bin is first on this process's PATH, and
//     all of it is installed before any server module is imported.
// Known gaps: a C extension that forks itself, or a raw socket to an IP, is
// not recorded; the git/gh PATH shims are the backstop for spawns.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { TEST_SHARED_SECRET, freePort, procEnviron } from './helpers/farmd.mjs'
import {
  SL_PATH_ENV_KEYS,
  implementInCheckout,
  makeScratch,
  readCalls,
  readPushes,
  recordServer,
  setDiffStatus,
  startSlFarmd,
} from './helpers/slPathFakes.mjs'

const REPO = 'scratch/ho881-scratch'
const SL_REPO = 'ho881-scratch' // farmd's bare name for it (backends/sl/review.js slRepoName)
const GITHUB_HOST = 'api.github.com'
const SECRET_KEYS = ['GITHUB_TOKEN', 'GH_TOKEN', 'SCREENSHOT_LOGIN_KEY']

// ---- the scratch world, before any server module loads ----

const scratch = makeScratch()
const { root } = scratch
const removeRoot = () => rmSync(root, { recursive: true, force: true })
process.on('exit', removeRoot) // backstop for a run that dies part-way

const farmPort = await freePort()
process.env.HORIZON_DB = scratch.dbPath
process.env.FARM_URL = `http://127.0.0.1:${farmPort}`
process.env.FARM_SHARED_SECRET = TEST_SHARED_SECRET
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // no real watchdog fires mid-test
process.env.FARM_STEP_TIMEOUT_MS = '600000'
process.env.PATH = `${scratch.binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`
for (const key of ['FARM_HOME', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET', 'CARETAKER_HOURLY_LIMIT', ...SECRET_KEYS]) delete process.env[key]

const farmd = await startSlFarmd(scratch, { farmPort })

const isGithub = (url) => {
  try {
    return new URL(url).hostname === GITHUB_HOST
  } catch {
    return false
  }
}
// fetch: recorded; api.github.com is refused with a 599, never sent.
const realFetch = globalThis.fetch
globalThis.fetch = (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input)
  const method = init.method ?? (input instanceof Request ? input.method : 'GET')
  recordServer(scratch, { kind: 'http', via: 'fetch', method, url })
  if (isGithub(url)) return Promise.resolve(new Response('{}', { status: 599 }))
  return realFetch(input, init)
}
// http(s).request: farmFetch's transport for long farmd calls (submit, land).
const requireCjs = createRequire(import.meta.url)
const describeRequest = (args, proto) => {
  const [first, second] = args
  if (typeof first === 'string' || first instanceof URL) return { method: (second && typeof second === 'object' && second.method) || 'GET', url: String(first) }
  const o = first ?? {}
  return { method: o.method || 'GET', url: `${proto}//${o.hostname ?? o.host ?? 'localhost'}${o.port ? `:${o.port}` : ''}${o.path ?? '/'}` }
}
for (const [name, proto] of [
  ['node:http', 'http:'],
  ['node:https', 'https:'],
]) {
  const mod = requireCjs(name)
  const original = mod.request
  mod.request = function recordedRequest(...args) {
    const { method, url } = describeRequest(args, proto)
    recordServer(scratch, { kind: 'http', via: `${proto.slice(0, -1)}.request`, method, url })
    if (isGithub(url)) throw new Error(`${GITHUB_HOST} is refused in the sl-path test`)
    return original.apply(this, args)
  }
}
// child_process: every spawn this process makes, by program name.
const childProcess = requireCjs('node:child_process')
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = childProcess[name]
  childProcess[name] = function recordedSpawn(...args) {
    const command = String(args[0])
    const bin = name === 'exec' || name === 'execSync' ? command.trim().split(/\s+/)[0] : command
    recordServer(scratch, { kind: 'spawn', how: name, bin: path.basename(bin) })
    return original.apply(this, args)
  }
}
syncBuiltinESMExports()

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { buildApp } = await import('../src/app.js')
const { refreshReviewStatus, submitDiff } = await import('../src/backends/index.js')
const { ACCEPT_GATE_INDEX, endIndex, stepKeyAt } = await import('../../domain/js/lifecycle.js')
const { loginFixtureUser } = await import('./helpers/session.mjs')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
await app.ready()
const { cookie, pin } = loginFixtureUser(auth, config)
const inject = (opts) => app.inject({ ...opts, headers: { cookie, 'x-human-key': pin, ...opts.headers } })
const approve = (id, stepIndex) => inject({ method: 'POST', url: `/api/items/${id}/move`, payload: { action: 'approve', from: stepKeyAt(stepIndex) } })

// ---- reading the log ----

const pathOf = (url) => new URL(url).pathname
const serverHttp = () => readCalls(scratch).filter((c) => c.src === 'server' && c.kind === 'http')
const indexOf = (calls, match, from = 0) => calls.findIndex((c, n) => n >= from && match(c))
const shim = (bin, ...argv) => (c) => c.src === 'shim' && c.bin === bin && argv.every((word, i) => c.argv[i] === word)
const phabRead = (c) => shim('sl', 'log', '-r', '.', '-T', '{phabstatus}')(c)
const serverTo = (method, p) => (c) => c.src === 'server' && c.kind === 'http' && c.method === method && c.url.startsWith(process.env.FARM_URL) && pathOf(c.url) === p
const toFarm = (method, p) => serverHttp().filter(serverTo(method, p))
const row = (id) => db.prepare('SELECT cursor, task_id, diff_id, diff_status, landed_hash, merged_at FROM work_item WHERE id = ?').get(id)
const events = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)
async function farmTasks() {
  // Read straight from farmd with the real fetch, so it is not on the log.
  const res = await realFetch(`${process.env.FARM_URL}/api/farm/tasks?repo=${encodeURIComponent(REPO)}`, { headers: { 'x-farm-secret': TEST_SHARED_SECRET } })
  assert.equal(res.status, 200)
  return (await res.json()).tasks
}

test('the sl path on a scratch project: Task → diff submitted and accepted → landed → Task closed with landed_hash; no GitHub, git or gh; a second land pushes nothing', async (t) => {
  try {
    // Guardrail 3: the DB this run opened is the scratch one.
    assert.ok(db.name.startsWith(root + path.sep), `the server DB ${db.name} is inside the scratch root ${root}`)

    // Guardrail 2: farmd's env is the allow-list, carrying no token.
    const farmEnv = procEnviron(farmd.pid)
    assert.ok(farmEnv, 'farmd’s environment is readable')
    assert.deepEqual(Object.keys(farmEnv).sort(), [...SL_PATH_ENV_KEYS].sort())
    for (const key of SECRET_KEYS) assert.equal(Object.hasOwn(farmEnv, key), false, `${key} is not passed to farmd`)

    // The scratch project: one sl repo, a repo check the land's test rebase runs.
    const projectId = store.createProject('HO-881 scratch sl project').id
    assert.equal(store.addRepoToProject(projectId, REPO, 'sl').ok, true)
    assert.equal(store.setRepoCheckCommands(projectId, REPO, { test: 'true' }).error, undefined)

    let id
    let task
    let diff
    let landedHash
    let landBody

    await t.test('step 1: a Task is created for the item', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/items',
        payload: { title: 'Scratch sl change', outcome: 'The sl path runs end to end.', metric: 'One Task closes with landed_hash recorded.', repo: REPO },
      })
      assert.equal(res.statusCode, 200, res.body)
      ;({ id, task_id: task } = res.json())
      assert.ok(Number.isSafeInteger(task) && task > 0, `a Task number, not ${task}`)
      assert.equal(row(id).task_id, String(task))
      assert.equal(toFarm('POST', '/api/farm/tasks').length, 1, 'one Task create through farmd')
      const tasks = await farmTasks()
      assert.deepEqual(
        tasks.map((x) => [x.number, x.title, x.state]),
        [[task, 'Scratch sl change', 'open']],
      )
    })

    await t.test('step 2: the diff is submitted, then accepted', async () => {
      // The implement step's farm-side work (no production code makes an sl
      // checkout yet): farm/vcs/sl.py checkout(), then one edited file.
      implementInCheckout(scratch, farmd.env, { repo: SL_REPO, itemId: id, file: 'feature.txt', text: 'the scratch change\n' })
      const submitted = await submitDiff(store.getItem(id), { summary: 'Adds feature.txt', testPlan: 'node --test' })
      diff = row(id).diff_id
      assert.match(diff ?? '', /^D\d+$/, 'the submitted diff is pinned on the item')
      assert.equal(submitted.diff, diff)
      assert.equal(submitted.updated, false)
      assert.equal(toFarm('POST', '/vcs/submit').length, 1)
      assert.equal(readCalls(scratch).filter(shim('jf', 'submit')).length, 1, 'one jf submit')

      // The reviewer accepts it on the (fake) Phabricator. Production reads it.
      setDiffStatus(scratch, diff, 'Accepted')
      assert.equal(await refreshReviewStatus(id, REPO), 'Accepted')
      assert.equal(row(id).diff_status, 'Accepted')
      const calls = readCalls(scratch)
      const read = indexOf(calls, (c) => phabRead(c) && c.out === 'Accepted', indexOf(calls, shim('jf', 'submit')))
      assert.ok(read > 0, 'farm/vcs/sl.py read the diff as Accepted after the submit')
    })

    await t.test('step 3: the diff is landed', async () => {
      // DB write: the item is at Accept the code.
      db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(ACCEPT_GATE_INDEX, id)
      const res = await approve(id, ACCEPT_GATE_INDEX)
      assert.equal(res.statusCode, 200, res.body)
      const pushes = readPushes(scratch)
      assert.equal(pushes.length, 1, 'one sl push')
      landedHash = row(id).landed_hash
      assert.match(landedHash ?? '', /^[0-9a-f]{40}$/)
      assert.equal(landedHash, pushes[0], 'landed_hash is exactly the commit the fake sl pushed')
      assert.ok(row(id).merged_at, 'the item is marked merged')
      assert.ok(row(id).cursor > ACCEPT_GATE_INDEX, 'the item moved past Accept the code')
      assert.equal(readCalls(scratch).filter(shim('sl', 'push', '-r', '.', '--to', 'master')).length, 1)
      const lands = serverHttp().filter(serverTo('POST', '/vcs/land'))
      assert.equal(lands.length, 1, 'one land request to farmd')
      assert.ok(events(id).includes(`landed ${diff} as ${landedHash.slice(0, 12)}`), events(id).join('\n'))
      landBody = { backend: 'sl', repo: SL_REPO, item: { id }, diff, check_commands: { test: 'true' }, timeout_s: 60 }
    })

    await t.test('step 4: the Task is closed, and landed_hash stays recorded', async () => {
      // DB write: from after Accept to the final gate.
      const kind = store.getItem(id).kind
      const finalGate = endIndex(kind) - 1
      db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(finalGate, id)
      const res = await approve(id, finalGate)
      assert.equal(res.statusCode, 200, res.body)
      assert.equal(row(id).cursor, endIndex(kind), 'the item is closed')
      const closes = toFarm('POST', `/api/farm/tasks/${task}/close`)
      assert.equal(closes.length, 1, 'one Task close through farmd')
      const [closed] = await farmTasks()
      assert.equal(closed.state, 'closed')
      assert.equal(row(id).landed_hash, landedHash)
    })

    await t.test('metric 1: one ordered log shows Task create → jf submit → Accepted → sl push → Task close', () => {
      const calls = readCalls(scratch)
      const create = indexOf(calls, serverTo('POST', '/api/farm/tasks'))
      const submit = indexOf(calls, shim('jf', 'submit'))
      const accepted = indexOf(calls, (c) => phabRead(c) && c.out === 'Accepted', submit)
      const land = indexOf(calls, serverTo('POST', '/vcs/land'))
      const push = indexOf(calls, shim('sl', 'push', '-r', '.', '--to', 'master'))
      const close = indexOf(calls, serverTo('POST', `/api/farm/tasks/${task}/close`))
      const order = { create, submit, accepted, push, close }
      for (const [step, at] of Object.entries(order)) assert.ok(at >= 0, `${step} is on the log`)
      assert.ok(create < submit && submit < accepted && accepted < push && push < close, `in order: ${JSON.stringify(order)}`)
      // The land itself re-read Accepted between its request and its push.
      const landRead = indexOf(calls, (c) => phabRead(c) && c.out === 'Accepted', land)
      assert.ok(land < landRead && landRead < push, `the land read Accepted before it pushed: ${JSON.stringify({ land, landRead, push })}`)
    })

    await t.test('metric 3: a second land run makes no second sl push, and landed_hash stays the same', async () => {
      const landsBefore = serverHttp().filter(serverTo('POST', '/vcs/land')).length

      // Run 2a, the server: Accept pressed again (DB write: the item back at
      // Accept the code). landed_hash is set, so no farmd land request at all.
      db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(ACCEPT_GATE_INDEX, id)
      const again = await approve(id, ACCEPT_GATE_INDEX)
      assert.equal(again.statusCode, 200, again.body)
      assert.ok(events(id).includes(`recorded landed ${diff} as ${landedHash.slice(0, 12)} (already on master — nothing pushed)`), events(id).join('\n'))
      assert.equal(serverHttp().filter(serverTo('POST', '/vcs/land')).length, landsBefore, 'no second land request')

      // Run 2b, the farm: a land request for the same item and pinned diff,
      // sent to farmd again. The push fake would succeed if called;
      // farm/vcs/sl.py finds the diff on master first.
      const res = await realFetch(`${process.env.FARM_URL}/vcs/land`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(landBody),
      })
      const body = await res.json()
      assert.equal(res.status, 200, JSON.stringify(body))
      assert.equal(body.ok, true)
      assert.equal(body.already_landed, true)
      assert.equal(body.commit, landedHash)

      assert.equal(readPushes(scratch).length, 1, 'still exactly one sl push')
      assert.equal(row(id).landed_hash, landedHash)
      assert.equal(toFarm('POST', `/api/farm/tasks/${task}/close`).length, 1, 'still exactly one Task close')
    })

    await t.test('metric 2: zero api.github.com calls and zero git or gh runs, from either process', () => {
      const calls = readCalls(scratch)
      // Positive controls: each recorder was live.
      assert.ok(
        calls.some((c) => c.src === 'farm' && c.kind === 'loaded' && c.pid === farmd.pid),
        'farmd loaded the subprocess recorder',
      )
      assert.ok(
        calls.some((c) => c.src === 'farm' && c.kind === 'spawn' && c.pid === farmd.pid && c.bin === 'sl'),
        'the recorder saw farmd spawn sl',
      )
      const taskCalls = [...toFarm('POST', '/api/farm/tasks'), ...toFarm('POST', `/api/farm/tasks/${task}/close`)]
      assert.deepEqual(
        taskCalls.map((c) => c.via),
        ['fetch', 'fetch'],
        'the fetch recorder saw the Task create and close',
      )
      assert.ok(serverHttp().some((c) => c.via === 'http.request'), 'the http.request recorder saw farmd’s long calls')
      assert.ok(
        calls.some((c) => c.src === 'server' && c.kind === 'spawn' && c.bin === path.basename(scratch.python)),
        'the child_process recorder saw this process spawn the checkout driver',
      )

      assert.deepEqual(
        serverHttp().filter((c) => isGithub(c.url)),
        [],
        'no api.github.com request from the server',
      )
      assert.deepEqual(
        calls.filter((c) => c.src === 'farm' && c.kind === 'dns'),
        [],
        'no api.github.com lookup from the farm',
      )
      const gitOrGh = calls.filter((c) => (c.src === 'shim' || c.kind === 'spawn') && ['git', 'gh'].includes(c.bin))
      assert.deepEqual(gitOrGh, [], 'no git or gh run')
      assert.deepEqual(
        calls.filter((c) => c.src === 'shim' && c.bin === 'eden'),
        [],
        'no eden run',
      )
      assert.deepEqual(farmd.sinkRequests, [], 'farmd made no call back to a Horizon server')
    })

    await t.test('guardrail 2: no token value reaches the call log', () => {
      const text = JSON.stringify(readCalls(scratch))
      assert.equal(text.includes(TEST_SHARED_SECRET), false, 'the farm secret is not on the log')
      assert.doesNotMatch(text, /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_/)
    })
  } finally {
    farmd.stop()
    await app.close()
    db.close()
    // Guardrail 3: the run removes everything it made.
    removeRoot()
    assert.equal(existsSync(root), false, 'the scratch root is gone')
  }
})
