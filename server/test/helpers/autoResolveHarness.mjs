// HZ-235: shared fixture for the auto-resolve-*.test.mjs files. Each test
// file is its own process, so setupAutoResolve() sets the env, then imports
// the real modules against a throwaway DB — the real signed webhook route,
// the real poll tick, the real resolveConflicts() and its lock. Only the two
// remote ends are faked, through one globalThis.fetch:
//   - GitHub (api.github.com): mergeability per PR, main's head sha and the
//     PRs behind a commit come from `gh`; every request is recorded, so a
//     test can assert nothing but reads went out.
//   - farmd (farm.test): each /conflicts/resolve call is parked until the
//     test replies — so a run can be held open — unless a reply was queued
//     with farmReplyNext(). Other farm routes answer {ok:true} at once.

import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

export const WEBHOOK_SECRET = 'whsec-SENTINEL-hz235'
export const TOKEN = 'ghp-SENTINEL-hz235'
export const REPO = 'acme/auto-resolve'
export const MAIN_SHA_1 = 'a'.repeat(40)
export const MAIN_SHA_2 = 'b'.repeat(40)
export const MAIN_SHA_3 = 'c'.repeat(40)

export async function setupAutoResolve(name, { webhookSecret = WEBHOOK_SECRET } = {}) {
  process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), `horizon-${name}-`)), 'test.db')
  process.env.FARM_URL = 'http://farm.test'
  process.env.FARM_CONFLICT_RESOLVE_TIMEOUT_MS = '60000' // < fetch header ceiling: stays on the stubbed fetch
  process.env.GITHUB_TOKEN = TOKEN
  process.env.AUTO_RESOLVE_DEBOUNCE_MS = '150'
  process.env.AUTO_RESOLVE_MERGEABLE_WAIT_MS = '50'
  delete process.env.AUTO_RESOLVE_ON_MAIN
  if (webhookSecret) process.env.GITHUB_WEBHOOK_SECRET = webhookSecret
  else delete process.env.GITHUB_WEBHOOK_SECRET

  const { db } = await import('../../src/db.js')
  const { buildApp } = await import('../../src/app.js')
  const lifecycle = await import('../../../domain/js/lifecycle.js')
  const config = await import('../../src/config.js')
  const store = await import('../../src/store.js')
  const auth = await import('../../src/auth.js')
  const settings = await import('../../src/settings.js')
  const github = await import('../../src/github.js')
  const orchestrator = await import('../../src/orchestrator.js')
  const autoResolve = await import('../../src/autoResolve.js')
  const { loginFixtureUser } = await import('./session.mjs')

  store.purgeDemoItems()
  const { id: projectId } = store.createProject(`${name} project`)
  assert.ok(store.addRepoToProject(projectId, REPO).ok)

  const gh = { mergeable: new Map(), mainSha: MAIN_SHA_1, commitPrs: new Map(), calls: [], onPrRead: null }
  let farmCalls = []
  const farmReplies = []
  const replyOk = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() })
  const replyStatus = (status, body = {}) => ({ ok: false, status, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() })

  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url)
    if (u.startsWith('http://farm.test')) {
      if (!u.endsWith('/conflicts/resolve')) return replyOk({ ok: true })
      const call = { body: opts.body ? JSON.parse(opts.body) : null }
      const reply = new Promise((resolve, reject) => Object.assign(call, { resolve, reject }))
      farmCalls.push(call)
      if (farmReplies.length > 0) call.resolve(replyOk(farmReplies.shift()))
      return reply
    }
    const path = u.replace('https://api.github.com', '')
    gh.calls.push({ method: opts.method || 'GET', path })
    if ((opts.method || 'GET') !== 'GET') return replyStatus(403)
    let m = path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/)
    if (m) {
      const n = Number(m[1])
      if (gh.onPrRead) gh.onPrRead(n)
      const mergeable = gh.mergeable.has(n) ? gh.mergeable.get(n) : true
      return replyOk({ number: n, state: 'open', merged: false, mergeable })
    }
    if (/\/git\/ref\/heads%2Fmain$/.test(path)) return replyOk({ object: { sha: gh.mainSha } })
    m = path.match(/\/commits\/([0-9a-f]{40})\/pulls$/)
    if (m) {
      const prs = gh.commitPrs.get(m[1]) || []
      return replyOk(prs.map((number) => ({ number, merged_at: '2026-10-02T00:00:00Z', base: { ref: 'main' } })))
    }
    return replyStatus(404)
  }

  // `lines` is cleared by reset(); `allLines` keeps every line for the
  // log-hygiene check.
  const lines = []
  const allLines = []
  const record = (m) => {
    lines.push(String(m))
    allLines.push(String(m))
  }
  const log = { info: record, warn: record, error: record }
  autoResolve.startAutoResolve(log)
  autoResolve.resetForTest() // drop the boot scan; auto-resolve-boot drives it itself

  const app = buildApp({ logger: false })
  const { pin, cookie } = loginFixtureUser(auth, config)

  const sign = (body) => 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')
  function webhook(event, payload, { signature } = {}) {
    const body = JSON.stringify({ repository: { full_name: REPO }, ...payload })
    const headers = { 'content-type': 'application/json', 'x-github-event': event }
    const sig = signature === undefined ? sign(body) : signature
    if (sig !== null) headers['x-hub-signature-256'] = sig
    return app.inject({ method: 'POST', url: '/api/webhooks/github', headers, payload: body })
  }
  const mergeWebhook = (pr, { base = 'main', merged = true, sha = MAIN_SHA_2, signature } = {}) =>
    webhook(
      'pull_request',
      { action: 'closed', pull_request: { number: pr, merged, state: 'closed', base: { ref: base }, merge_commit_sha: sha } },
      { signature },
    )

  const insertStmt = db.prepare(
    `INSERT INTO work_item (id, title, priority, cursor, repo, pr, pr_mergeable, paused, abandoned_at, project_id)
     VALUES (@id, @id, 'Medium', @cursor, @repo, @pr, @mergeable, @paused, @abandonedAt, @projectId)`,
  )
  function insertItem(id, { cursor = lifecycle.ACCEPT_GATE_INDEX, pr = null, mergeable = null, paused = 0, abandoned = false, projectId: pid = projectId, repo = REPO } = {}) {
    insertStmt.run({ id, cursor, repo, pr, mergeable, paused, abandonedAt: abandoned ? '2026-10-01T00:00:00Z' : null, projectId: pid })
  }
  // A conflicted item at the Accept gate: GitHub says mergeable:false.
  function conflictedAtGate(id, pr) {
    insertItem(id, { pr, mergeable: 1 })
    gh.mergeable.set(pr, false)
  }
  function startStep(id, stepIndex) {
    return db
      .prepare("INSERT INTO step_run (item_id, step_index, agent, status) VALUES (?, ?, ?, 'active')")
      .run(id, stepIndex, lifecycle.STEPS[stepIndex].agent).lastInsertRowid
  }

  const itemLines = (id) => lines.filter((l) => new RegExp(`\\] ${id}(?: PR #\\d+)?: `).test(l))
  const events = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((r) => r.text)
  const gateAction = (id) => db.prepare("SELECT * FROM gate_action WHERE item_id = ? AND kind = 'resolve'").get(id)
  const row = (id) => db.prepare('SELECT * FROM work_item WHERE id = ?').get(id)
  const resolveCallsFor = (id) => farmCalls.filter((c) => c.body?.item?.id === id)
  const nonGetGithubCalls = () => gh.calls.filter((c) => c.method !== 'GET')
  const resolvePost = (id) =>
    app.inject({ method: 'POST', url: `/api/items/${id}/resolve-conflicts`, payload: {}, headers: { cookie, 'x-human-key': pin } })

  async function untilFarmCalls(n) {
    for (let i = 0; i < 400 && farmCalls.length < n; i++) await new Promise((r) => setTimeout(r, 5))
    assert.equal(farmCalls.length, n, `expected ${n} farm resolve call(s)`)
  }
  async function untilLine(re) {
    for (let i = 0; i < 400 && !lines.some((l) => re.test(l)); i++) await new Promise((r) => setTimeout(r, 5))
    assert.ok(lines.some((l) => re.test(l)), `expected a log line matching ${re}`)
  }
  const farmReplyNext = (body) => farmReplies.push(body)
  const resolved = { ok: true, resolved: true, summary: 'merged and pushed' }

  // The poll tick, as production runs it (github.pollOnce → main-head hook).
  const pollTick = async () => {
    await github.pollOnce(log)
    await autoResolve.whenIdleForTest()
  }

  async function reset() {
    await autoResolve.whenIdleForTest()
    autoResolve.resetForTest()
    db.prepare('DELETE FROM gate_action').run()
    settings.setSetting('auto_resolve_on_main', '1')
    db.prepare("DELETE FROM setting WHERE key = 'auto_resolve_on_main'").run()
    lines.length = 0
    farmCalls = []
    farmReplies.length = 0
    gh.calls.length = 0
    gh.mergeable.clear()
    gh.commitPrs.clear()
    gh.onPrRead = null
    gh.mainSha = MAIN_SHA_1
  }

  return {
    db,
    lifecycle,
    store,
    settings,
    github,
    orchestrator,
    autoResolve,
    app,
    gh,
    lines,
    allLines,
    projectId,
    get farmCalls() {
      return farmCalls
    },
    webhook,
    mergeWebhook,
    insertItem,
    conflictedAtGate,
    startStep,
    itemLines,
    events,
    gateAction,
    row,
    resolveCallsFor,
    nonGetGithubCalls,
    resolvePost,
    untilFarmCalls,
    untilLine,
    farmReplyNext,
    replyOk,
    resolved,
    pollTick,
    reset,
  }
}
