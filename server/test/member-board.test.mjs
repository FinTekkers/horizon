// HZ-656: each signed-in user's board holds only the projects they belong to,
// on first load (GET /api/items, the stream's snapshot frame) and in every
// live delta. The owner's frames do not change. A membership change reaches a
// connected tab on its next frame, and a project it left never comes back in a
// later delta. A failed membership lookup shows nothing, never everything.
//
// Its own file because config.js reads the environment at import time. Runs
// over real sockets: /api/stream hijacks its reply, so inject() cannot read it.

import { after, before, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { loginFixtureUser } from './helpers/session.mjs'
import { seedMemberBoard } from './helpers/memberBoardSeed.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-member-board-')), 'test.db')
delete process.env.FARM_URL
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const appModule = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const access = await import('../src/access.js')
const { viewSnapshot } = await import('../src/boardView.js')
const { makeBaseline, diffSnapshot } = await import('../src/streamDelta.js')
const { setSetting } = await import('../src/settings.js')
const { unlinkedProjectId } = await import('../src/membership.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const { A, C, ids } = seedMemberBoard(db, { setSetting, unlinkedProjectId })
const A_IDS = [...ids.A].sort()

// The membership lookup the app uses, switchable to a throw for the
// fail-closed case.
let lookupFails = false
const app = appModule.buildApp({
  logger: false,
  memberProjects(userId) {
    if (lookupFails) throw new Error('membership lookup exploded')
    return access.memberProjectIds(userId)
  },
})
let base
before(async () => {
  await app.listen({ port: 0, host: '127.0.0.1' })
  base = `http://127.0.0.1:${app.server.address().port}`
})
after(() => app.close())

const owner = loginFixtureUser(auth, config)
const alice = loginFixtureUser(auth, config, { email: 'alice@example.com', name: 'Alice Member', role: 'member' })
const nobody = loginFixtureUser(auth, config, { email: 'nobody@example.com', name: 'No Project', role: 'member' })
const addMember = db.prepare('INSERT OR IGNORE INTO project_member (project_id, user_id) VALUES (?, ?)')
const removeMember = db.prepare('DELETE FROM project_member WHERE project_id = ? AND user_id = ?')
// Alice is in A and in C, which is disabled.
addMember.run(A, alice.user.id)
addMember.run(C, alice.user.id)

const setTitle = db.prepare('UPDATE work_item SET title = ? WHERE id = ?')
const titleOf = (id) => db.prepare('SELECT title FROM work_item WHERE id = ?').get(id).title
// Writes the titles, runs `fn`, then puts them back and drains that flush.
async function withTitles(changes, fn) {
  const before = Object.fromEntries(Object.keys(changes).map((id) => [id, titleOf(id)]))
  try {
    return await fn()
  } finally {
    for (const [id, title] of Object.entries(before)) setTitle.run(title, id)
    appModule.flushStream()
  }
}

const get = (url, who) => app.inject({ method: 'GET', url, headers: { cookie: who.cookie } })
const idsOf = (items) => items.map((item) => item.id).sort()
const isSnapshot = (f) => f.event === 'snapshot'
const isDelta = (f) => f.event === 'delta'

// An SSE client over fetch: parses frames into { event, data, raw }.
async function openStream(path, who) {
  const controller = new AbortController()
  const res = await fetch(`${base}${path}`, { headers: { cookie: who.cookie }, signal: controller.signal })
  const frames = []
  let ended = false
  ;(async () => {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let cut
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          const frame = { event: 'message', data: null, raw: block }
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) frame.event = line.slice(7)
            else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6))
          }
          frames.push(frame)
        }
      }
    } catch {
      // aborted by close()
    }
    ended = true
  })()
  // The first frame from index `from` on that matches, or null after `timeoutMs`.
  async function next(match = () => true, { from = 0, timeoutMs = 5000 } = {}) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = frames.slice(from).find(match)
      if (hit) return hit
      if (ended || Date.now() > deadline) return null
      await sleep(5)
    }
  }
  return { res, frames, next, after: (frame) => frames.indexOf(frame) + 1, ended: () => ended, close: () => controller.abort() }
}

async function waitForClients(n) {
  for (let i = 0; i < 200 && appModule.streamClientCount() !== n; i++) await sleep(10)
  assert.equal(appModule.streamClientCount(), n)
}

// Every path in `value` whose key is one a member must never get.
const FORBIDDEN_KEYS = new Set([
  'testEnvFile',
  'checks',
  'marks',
  'defaultBranch',
  'isolation',
  'githubTokenRef',
  'runUser',
  'farm',
  'sync',
  'deployBlock',
])
function forbiddenPaths(value, path = '$') {
  if (value == null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => [
    ...(FORBIDDEN_KEYS.has(key) ? [`${path}.${key}`] : []),
    ...forbiddenPaths(child, `${path}.${key}`),
  ])
}
// Text of anything outside Alice's enabled projects: B's and C's items, B's
// name and credential reference, the unlinked and no-project items, and every
// repo's check commands and test-env file.
const OUTSIDE_TEXT = ['BR-1', 'BR-PLAN', 'bravo', 'Bravo', '$BRAVO_TOKEN', 'CH-1', 'charlie disabled', 'UL-1', 'NP-1', '/etc/horizon', 'npm run lint', 'pytest']
function assertMemberSafe(payload, label) {
  assert.deepEqual(forbiddenPaths(payload), [], `${label} carries an owner-only key`)
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  for (const needle of OUTSIDE_TEXT) assert.ok(!text.includes(needle), `${label} carries "${needle}"`)
}

test('metric 1: a project-B change reaches only the owner, byte-equal to an owner-only run; the no-project user gets one empty snapshot and no delta', async () => {
  // The owner alone: the frame a B change makes with no member connected.
  let soloDelta
  const solo = await openStream('/api/stream?v=2', owner)
  try {
    await solo.next(isSnapshot)
    await withTitles({ 'BR-1': true }, async () => {
      setTitle.run('bravo renamed', 'BR-1')
      appModule.flushStream()
      soloDelta = await solo.next(isDelta)
      assert.deepEqual(idsOf(soloDelta.data.upserts), ['BR-1'])
    })
  } finally {
    solo.close()
  }
  await waitForClients(0)

  const ownerTab = await openStream('/api/stream?v=2', owner)
  const aliceTab = await openStream('/api/stream?v=2', alice)
  const nobodyTab = await openStream('/api/stream?v=2', nobody)
  try {
    const emptySnap = await nobodyTab.next(isSnapshot)
    assert.deepEqual(emptySnap.data.items, [])
    assert.deepEqual(emptySnap.data.projects, [])
    const aliceSnap = await aliceTab.next(isSnapshot)
    assert.deepEqual(idsOf(aliceSnap.data.items), A_IDS)
    await ownerTab.next(isSnapshot)
    await waitForClients(3)

    await withTitles({ 'BR-1': true, 'AL-2': true }, async () => {
      setTitle.run('bravo renamed', 'BR-1')
      appModule.flushStream()
      const ownerDelta = await ownerTab.next(isDelta)
      assert.equal(ownerDelta.raw, soloDelta.raw, "members connected changed the owner's frame")

      // An A change next: Alice's first delta is that one, so the B change
      // sent her nothing.
      setTitle.run('alpha renamed', 'AL-2')
      appModule.flushStream()
      const aliceDelta = await aliceTab.next(isDelta)
      assert.deepEqual(idsOf(aliceDelta.data.upserts), ['AL-2'])
      assert.deepEqual(aliceDelta.data.removed, [])
      assertMemberSafe(aliceDelta.raw, 'Alice delta')
      assert.ok(await ownerTab.next(isDelta, { from: ownerTab.after(ownerDelta) }))
      await sleep(300)
      assert.deepEqual(
        nobodyTab.frames.filter((f) => f.event !== 'heartbeat').map((f) => f.event),
        ['snapshot'],
      )
    })
  } finally {
    ownerTab.close()
    aliceTab.close()
    nobodyTab.close()
  }
  await waitForClients(0)
})

test("with no active project, the member's disabled project, `Unlinked items` and no-project items stay out of the first frame and every delta", async () => {
  setSetting('active_project_id', '')
  const tab = await openStream('/api/stream?v=2', alice)
  try {
    const snap = await tab.next(isSnapshot)
    assert.equal(snap.data.activeProjectId, null)
    assert.deepEqual(idsOf(snap.data.items), A_IDS)
    // The owner's board does carry them while no project is active.
    assert.ok(['CH-1', 'UL-1', 'NP-1'].every((id) => appModule.snapshot({ scope: 'enabled' }).items.some((it) => it.id === id)))
    await withTitles({ 'CH-1': true, 'UL-1': true, 'NP-1': true, 'AL-2': true }, async () => {
      for (const id of ['CH-1', 'UL-1', 'NP-1', 'AL-2']) setTitle.run(`${id} renamed`, id)
      appModule.flushStream()
      const delta = await tab.next(isDelta)
      assert.deepEqual(idsOf(delta.data.upserts), ['AL-2'])
    })
    assert.deepEqual(idsOf((await get('/api/items?v=2', alice)).json().items), A_IDS)
    for (const frame of tab.frames) for (const id of ['CH-1', 'UL-1', 'NP-1']) assert.ok(!frame.raw.includes(id), `${frame.event} names ${id}`)
  } finally {
    tab.close()
    setSetting('active_project_id', String(A))
    appModule.flushStream()
  }
  await waitForClients(0)
})

test("metric 2: a project-A member's GET /api/items, legacy and ?v=2, and both streams hold only A, with no owner-only key", async () => {
  for (const url of ['/api/items', '/api/items?v=2']) {
    const res = await get(url, alice)
    assert.equal(res.statusCode, 200, url)
    const board = res.json()
    assert.deepEqual(idsOf(board.items), A_IDS, url)
    assert.deepEqual(
      board.projects.map((p) => p.id),
      [A, C],
      url,
    )
    assertMemberSafe(board, url)
    // AL-2 was filed by BR-PLAN: the link is dropped, not just the item.
    assert.equal(board.items.find((it) => it.id === 'AL-2').spawnedBy, null)
    assert.deepEqual(
      board.planProgress.map((row) => row.id),
      ['AL-PLAN'],
    )
  }
  // The owner still gets every field.
  const ownerBoard = (await get('/api/items?v=2', owner)).json()
  assert.equal(ownerBoard.projects.find((p) => p.id === A).repos[0].testEnvFile, '/etc/horizon/alpha.env')
  assert.ok('farm' in ownerBoard && 'sync' in ownerBoard && 'deployBlock' in ownerBoard)

  // The no-project user's list is empty.
  const empty = (await get('/api/items?v=2', nobody)).json()
  assert.deepEqual(empty.items, [])
  assert.deepEqual(empty.projects, [])
  assertMemberSafe(empty, 'no-project board')

  // The legacy stream branch: one full frame, then the stream ends.
  const legacy = await openStream('/api/stream', alice)
  const frame = await legacy.next()
  assert.deepEqual(idsOf(frame.data.items), A_IDS)
  assertMemberSafe(frame.raw, 'legacy stream frame')
  legacy.close()

  // The v2 stream: its snapshot, and a delta whose `top` carries projects.
  const tab = await openStream('/api/stream?v=2', alice)
  try {
    assertMemberSafe((await tab.next(isSnapshot)).raw, 'snapshot frame')
    db.prepare("UPDATE project SET autopilot = 'shadow' WHERE id = ?").run(A)
    db.prepare("UPDATE project_repo SET test_env_file = '/etc/horizon/alpha-2.env' WHERE project_id = ?").run(A)
    appModule.flushStream()
    const delta = await tab.next(isDelta)
    assert.ok(delta.data.top.projects, 'no projects change in top')
    assert.equal(delta.data.top.projects.find((p) => p.id === A).autopilot, 'shadow')
    assertMemberSafe(delta.raw, 'delta frame')
  } finally {
    tab.close()
    db.prepare("UPDATE project SET autopilot = 'off' WHERE id = ?").run(A)
    db.prepare("UPDATE project_repo SET test_env_file = '/etc/horizon/alpha.env' WHERE project_id = ?").run(A)
    appModule.flushStream()
  }
  await waitForClients(0)
})

test("metric 4: removing a connected member from A drops A's items on the next frame, with no reconnect, and no later delta carries them", async () => {
  const tab = await openStream('/api/stream?v=2', alice)
  try {
    const snap = await tab.next(isSnapshot)
    assert.deepEqual(idsOf(snap.data.items), A_IDS)
    await waitForClients(1)

    removeMember.run(A, alice.user.id)
    store.notifyChange()
    appModule.flushStream()
    const removal = await tab.next(isDelta)
    assert.deepEqual([...removal.data.removed].sort(), A_IDS)
    assert.deepEqual(removal.data.upserts, [])
    assert.deepEqual(removal.data.order, [])
    assert.ok(!removal.data.top.projects.some((p) => p.id === A), 'A is still in projects')
    assert.ok(!tab.ended(), 'the tab was disconnected')
    assert.equal(appModule.streamClientCount(), 1)

    // Two later A changes; then a C change, which she still sees, as a barrier.
    await withTitles({ 'AL-1': true, 'AL-2': true }, async () => {
      setTitle.run('alpha after removal 1', 'AL-1')
      appModule.flushStream()
      setTitle.run('alpha after removal 2', 'AL-2')
      appModule.flushStream()
      db.prepare("UPDATE project SET name = 'Charlie two' WHERE id = ?").run(C)
      appModule.flushStream()
      const barrier = await tab.next(isDelta, { from: tab.after(removal) })
      assert.deepEqual(Object.keys(barrier.data.top), ['projects'])
      const later = tab.frames.slice(tab.after(removal))
      assert.deepEqual(
        later.filter(isDelta),
        [barrier],
        'a delta went out for an A change',
      )
      for (const frame of later) assert.ok(!frame.raw.includes('AL-'), `${frame.event} names an A item`)
    })
  } finally {
    tab.close()
    addMember.run(A, alice.user.id)
    db.prepare("UPDATE project SET name = 'Charlie' WHERE id = ?").run(C)
    appModule.flushStream()
  }
  await waitForClients(0)
})

test('one owner and two members: each flush lists the items and the spawn parents once', async () => {
  const tabs = [await openStream('/api/stream?v=2', owner), await openStream('/api/stream?v=2', alice), await openStream('/api/stream?v=2', nobody)]
  const Statement = Object.getPrototypeOf(db.prepare('SELECT 1'))
  try {
    for (const tab of tabs) await tab.next(isSnapshot)
    await waitForClients(3)
    await withTitles({ 'AL-1': true }, async () => {
      setTitle.run('counted', 'AL-1')
      const all = mock.method(Statement, 'all')
      try {
        appModule.flushStream()
      } finally {
        all.mock.restore()
      }
      const sources = all.mock.calls.map((call) => call.this.source)
      assert.equal(sources.filter((sql) => sql.includes('FROM work_item w ORDER BY w.id')).length, 1, 'store.listItems')
      assert.equal(sources.filter((sql) => sql.includes('SELECT DISTINCT w.* FROM item_spawn')).length, 1, 'store.spawnParents')
      assert.ok(await tabs[1].next(isDelta), 'the member got no delta')
    })
  } finally {
    for (const tab of tabs) tab.close()
  }
  await waitForClients(0)
})

test("filtering never mutates the shared board or another member's baseline", () => {
  const board = appModule.snapshot({ scope: 'enabled', stepOutputs: false })
  const boardBefore = structuredClone(board)
  const parents = store.spawnParents()
  const view = (projectIds) => {
    const viewer = { projectIds: new Set(projectIds) }
    return viewSnapshot(board, viewer, { itemVisible: store.viewerItemFilter(viewer), parents })
  }
  const first = makeBaseline(view([A]))
  const firstBefore = structuredClone(first)
  const second = view([A, C])
  diffSnapshot(makeBaseline(view([])), second)
  // A member's copy is its own: writing to it reaches neither the board nor
  // the other member's view.
  const al2 = second.items.find((it) => it.id === 'AL-2')
  al2.title = 'scribbled'
  second.projects[0].repos.push({ repo: 'scribbled' })
  assert.deepEqual(board, boardBefore)
  assert.deepEqual(first, firstBefore)
  assert.equal(board.items.find((it) => it.id === 'AL-2').spawnedBy.id, 'BR-PLAN', "the owner's link to BR-PLAN was dropped")
})

test('a membership lookup that throws fails closed: 404s, every row removed, the item stream ended, and an empty viewer for a bad user id', async () => {
  const tab = await openStream('/api/stream?v=2', alice)
  const itemTab = await openStream('/api/items/AL-1/stream', alice)
  try {
    assert.deepEqual(idsOf((await tab.next(isSnapshot)).data.items), A_IDS)
    assert.ok(await itemTab.next((f) => f.event === 'outputs'))
    await waitForClients(1)
    lookupFails = true
    for (const url of ['/api/items', '/api/items?v=2', '/api/stream?v=2', '/api/items/AL-2/stream']) {
      const res = await get(url, alice)
      assert.equal(res.statusCode, 404, url)
      assert.deepEqual(res.json(), { error: 'not_found' }, url)
    }
    store.notifyChange()
    appModule.flushStream()
    const delta = await tab.next(isDelta)
    assert.deepEqual([...delta.data.removed].sort(), A_IDS)
    assert.deepEqual(delta.data.top.projects, [])
    for (let i = 0; i < 200 && !itemTab.ended(); i++) await sleep(10)
    assert.ok(itemTab.ended(), 'the item stream stayed open')
    assert.equal(appModule.itemStreamClientCount('AL-1'), 0)
    // The owner never reads membership, so the owner's board is unchanged.
    assert.deepEqual(idsOf((await get('/api/items?v=2', owner)).json().items), idsOf(appModule.snapshot({ scope: 'enabled' }).items))
  } finally {
    lookupFails = false
    tab.close()
    itemTab.close()
    appModule.flushStream()
  }
  await waitForClients(0)

  for (const userId of [undefined, null, 42, '']) {
    assert.deepEqual(access.viewerForUser(userId), { projectIds: new Set() }, String(userId))
    assert.deepEqual(access.viewerFor({ user: userId === undefined ? undefined : { id: userId } }), { projectIds: new Set() }, String(userId))
  }
  assert.equal(access.viewerForUser(owner.user.id), null)
})
