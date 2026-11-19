// HZ-921 metric 5: closing or abandoning an item posts one GitHub comment — one
// summary line above one fenced `json` block headed <!-- horizon-stats v1 -->,
// whose values match the item's summary. A second close, the backfill and an
// issue whose stats comment sits on page 2 edit or skip it, never add one.
// A failed post never blocks or undoes the close. Driven through the real
// move and abandon routes with GitHub's API stubbed; every post is awaited
// (settleStatsPosts), so no stub answers after a case ends.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loginFixtureUser } from './helpers/session.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'horizon-item-stats-comment-'))
process.env.HORIZON_DB = join(scratch, 'test.db')
process.env.HOME = join(scratch, 'home')
process.env.GITHUB_TOKEN = 'stats-comment-fake-token'
delete process.env.FARM_URL
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const { itemStats } = await import('../src/itemStats.js')
const {
  STATS_MARKER,
  backfillItemStats,
  formatClarification,
  formatCost,
  formatDuration,
  formatTokens,
  formatTurns,
  postItemStats,
  settleStatsPosts,
  statsBlock,
} = await import('../src/statsComment.js')
const { endIndex, stepIndexOf, stepKeyAt } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
await app.ready()
after(() => app.close())
const { pin, cookie } = loginFixtureUser(auth, config)
const inject = (opts) => app.inject({ ...opts, headers: { 'x-human-key': pin, ...opts.headers, cookie } })

const REPO = 'acme/stats-comment'
const { id: projectId } = store.createProject('HZ-921 stats comment')
assert.ok(store.addRepoToProject(projectId, REPO).ok)
const IMPLEMENT = stepIndexOf('change.implement')
const CLOSE_GATE = endIndex('change') - 1

let issueSeq = 100
function seedItem(id, { cursor = CLOSE_GATE, turns = 12 } = {}) {
  const issue = ++issueSeq
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, repo, issue, project_id, kind, created_at) VALUES (?, ?, 'Medium', ?, ?, ?, ?, 'change', '2026-11-10 09:00:00')",
  ).run(id, id, cursor, REPO, issue, projectId)
  db.prepare(
    `INSERT INTO step_run (item_id, step_index, attempt, agent, status, started_at, ended_at, agent_run, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, cost_usd, num_turns, model, provider)
     VALUES (?, ?, 1, 'Eng', 'done', '2026-11-10 10:00:00', '2026-11-10 11:00:00', 1, 120000, 30000, 900000, 5000, 3.456, ?, 'claude-opus-5-5', 'claude')`,
  ).run(id, IMPLEMENT, turns)
  return { id, issue }
}

// GitHub's issue and comment routes, in memory. Every request is recorded.
function stubGithub({ failList = false } = {}) {
  const realFetch = globalThis.fetch
  const calls = []
  const threads = new Map() // issue number → [{ id, body, user }]
  let nextId = 1
  const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  const threadOf = (n) => threads.get(n) ?? threads.set(n, []).get(n)
  globalThis.fetch = async (input, opts = {}) => {
    const url = new URL(String(input))
    const method = (opts.method || 'GET').toUpperCase()
    const body = opts.body ? JSON.parse(opts.body) : null
    calls.push({ method, path: url.pathname, search: url.search, body })
    if (url.origin !== 'https://api.github.com') throw new Error(`stray request: ${url.href}`)
    const list = new RegExp(`^/repos/${REPO}/issues/(\\d+)/comments$`).exec(url.pathname)
    if (list && method === 'GET') {
      if (failList) return json(500, { message: 'boom' })
      const perPage = Number(url.searchParams.get('per_page') || 30)
      const page = Number(url.searchParams.get('page') || 1)
      return json(200, threadOf(Number(list[1])).slice((page - 1) * perPage, page * perPage))
    }
    if (list && method === 'POST') {
      const comment = { id: nextId++, body: body.body, user: { login: 'horizon-app', type: 'User' } }
      threadOf(Number(list[1])).push(comment)
      return json(201, comment)
    }
    const edit = new RegExp(`^/repos/${REPO}/issues/comments/(\\d+)$`).exec(url.pathname)
    if (edit && method === 'PATCH') {
      const comment = [...threads.values()].flat().find((c) => c.id === Number(edit[1]))
      if (!comment) return json(404, {})
      comment.body = body.body
      return json(200, comment)
    }
    return json(200, {}) // the issue close, labels
  }
  return {
    calls,
    threadOf,
    seed: (n, comment) => threadOf(n).push({ id: nextId++, ...comment }),
    statsComments: (n) => threadOf(n).filter((c) => c.body.includes(STATS_MARKER)),
    statsPosts: () => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/comments') && c.body.body.includes(STATS_MARKER)),
    restore: () => (globalThis.fetch = realFetch),
  }
}

async function withGithub(options, body) {
  const gh = stubGithub(options)
  try {
    return await body(gh)
  } finally {
    await settleStatsPosts()
    gh.restore()
  }
}

const approveFinal = (id) => inject({ method: 'POST', url: `/api/items/${id}/move`, payload: { action: 'approve', from: stepKeyAt(CLOSE_GATE) } })
const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const eventTexts = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)

// The comment's parts: [summary line, block]. Asserts its shape on the way.
function partsOf(body) {
  const lines = body.split('\n')
  assert.match(lines[0], /^\*\*Effort & cost:\*\* /)
  assert.equal(lines[1], '')
  assert.equal(lines[2], STATS_MARKER)
  assert.equal(lines[3], '```json')
  assert.equal(body.split(STATS_MARKER).length, 2, 'one marker')
  assert.equal(body.split('```json').length, 2, 'one json block')
  const end = lines.indexOf('```', 4)
  assert.ok(end > 4, 'the block is closed')
  return [lines[0], JSON.parse(lines.slice(4, end).join('\n'))]
}

test('closing posts one comment: one summary line above one horizon-stats v1 json block, matching the summary', async () => {
  const { id, issue } = seedItem('SC-1')
  await withGithub({}, async (gh) => {
    const res = await approveFinal(id)
    assert.equal(res.statusCode, 200, res.body)
    await settleStatsPosts()
    assert.equal(gh.statsPosts().length, 1)
    const [comment] = gh.statsComments(issue)
    const [line, block] = partsOf(comment.body)
    const stats = itemStats(id)
    assert.deepEqual(block, JSON.parse(JSON.stringify(statsBlock(stats))))
    assert.equal(block.schema, 'horizon-stats')
    assert.equal(block.version, 1)
    assert.equal(block.outcome, 'closed')
    // The line's values are the block's.
    assert.ok(line.includes(`Cost ${formatCost(block.totals.cost_usd)}`), line)
    assert.ok(line.includes(`implement ${formatTokens(block.implementation.tokens)}, ${formatTurns(block.implementation.turns)}`), line)
    assert.ok(line.includes(`elapsed ${formatDuration(block.time.elapsed_ms)}`), line)
    assert.ok(line.includes(formatClarification(block.clarification)), line)
    assert.ok(line.includes('$3.46') && line.includes('150.0K tokens') && line.includes('12 turns'), line)
  })
})

test('a second close and the backfill update or skip the comment, and never add a second one', async () => {
  const { id, issue } = seedItem('SC-2')
  await withGithub({}, async (gh) => {
    assert.equal((await approveFinal(id)).statusCode, 200)
    await settleStatsPosts()
    assert.equal(await postItemStats(store.getItem(id)), 'unchanged') // close's post, again
    const [backfilled] = (await backfillItemStats({ itemId: id })).map((row) => row.result)
    assert.equal(backfilled, 'unchanged')
    // The data moves on (a late retry event): the next run edits the one comment.
    db.prepare(
      "INSERT INTO event (item_id, who, text, color, initials) VALUES (?, 'Horizon', 'transient failure (x): y — auto-retrying (1/2)', '#000', 'HZ')",
    ).run(id)
    assert.equal((await backfillItemStats({ itemId: id }))[0].result, 'updated')
    assert.equal(gh.statsPosts().length, 1, 'one POST in all')
    assert.equal(gh.statsComments(issue).length, 1)
    assert.equal(partsOf(gh.statsComments(issue)[0].body)[1].clarification.auto_retries, 1)
  })
})

test('a stats comment on the second page of a long issue is edited, not posted again', async () => {
  const { id, issue } = seedItem('SC-3', { cursor: endIndex('change') })
  await withGithub({}, async (gh) => {
    for (let i = 0; i < 120; i++) gh.seed(issue, { body: `comment ${i}`, user: { login: 'someone', type: 'User' } })
    gh.seed(issue, { body: `old line\n\n${STATS_MARKER}\n\`\`\`json\n{}\n\`\`\`\n\n_posted by Horizon_`, user: { login: 'horizon-app', type: 'User' } })
    for (let i = 0; i < 5; i++) gh.seed(issue, { body: `later ${i}`, user: { login: 'someone', type: 'User' } })
    assert.equal(await postItemStats(store.getItem(id)), 'updated')
    assert.equal(gh.statsPosts().length, 0)
    assert.ok(gh.calls.some((c) => c.method === 'GET' && c.search.includes('page=2')), 'page 2 was read')
    assert.equal(gh.statsComments(issue).length, 1)
    assert.equal(partsOf(gh.statsComments(issue)[0].body)[1].item, id)
  })
})

test('abandoning posts one comment with outcome "abandoned"', async () => {
  const { id, issue } = seedItem('SC-4', { cursor: IMPLEMENT })
  await withGithub({}, async (gh) => {
    const res = await inject({ method: 'POST', url: `/api/items/${id}/abandon`, payload: { reason: 'Not needed any more.' } })
    assert.equal(res.statusCode, 200, res.body)
    await settleStatsPosts()
    assert.equal(gh.statsPosts().length, 1)
    assert.equal(partsOf(gh.statsComments(issue)[0].body)[1].outcome, 'abandoned')
  })
  orchestrator.cancel(id, 'cancelled')
})

test('a GitHub 500 leaves the item closed, logs a red event, and posts nothing', async () => {
  const { id } = seedItem('SC-5')
  await withGithub({ failList: true }, async (gh) => {
    const res = await approveFinal(id)
    assert.equal(res.statusCode, 200, res.body)
    await settleStatsPosts()
    assert.equal(cursorOf(id), endIndex('change'))
    assert.equal(gh.statsPosts().length, 0)
  })
  const event = db.prepare("SELECT text, color FROM event WHERE item_id = ? AND text LIKE 'could not post the effort & cost stats%'").get(id)
  assert.ok(event, eventTexts(id).join('\n'))
  assert.equal(event.color, '#9C333E')
  assert.match(event.text, /GitHub returned 500/)
})

test('the backfill makes no request for an open item', async () => {
  const { id } = seedItem('SC-6', { cursor: IMPLEMENT })
  await withGithub({}, async (gh) => {
    assert.deepEqual(await backfillItemStats({ itemId: id }), [])
    assert.equal(await postItemStats(store.getItem(id)), 'skipped')
    assert.deepEqual(gh.calls, [])
  })
})

test('the backfill script’s --dry-run prints each closed item’s line, sends nothing, and shows unrecorded turns as not recorded', () => {
  const { id } = seedItem('SC-7', { cursor: endIndex('change'), turns: null })
  const script = fileURLToPath(new URL('../scripts/backfill-item-stats.mjs', import.meta.url))
  const env = { ...process.env, GITHUB_TOKEN: '' }
  delete env.FARM_HOME
  const out = spawnSync(process.execPath, [script, '--dry-run', '--item', id], { env, encoding: 'utf8' })
  assert.equal(out.status, 0, out.stderr)
  const lines = out.stdout.trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines.map((l) => [l.id, l.result]), [[id, 'dry-run']])
  assert.match(lines[0].line, /turns not recorded/)
})
