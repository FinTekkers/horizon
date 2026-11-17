// HO-875: the server tests' farmd for the sl Tracker — a fetch handler that
// answers farmd's /api/farm/tasks routes the way farm/farmd.py does over
// farm/task_driver.py's StubTaskDriver. Both are checked against one wire
// contract, farm/tests/fixtures/farm_tasks_contract.json (FARM_TASKS_CONTRACT
// below; replayed by tracker-contract-sl.test.mjs here and by
// farm/tests/test_farmd_tasks.py there).
//
// It records every request it sees, refuses any URL that is not FARM_URL's
// Task routes (recording it in `strays`), and lets a test script the farm:
// outside comments and closes, the next Task number, a refusal, or a create
// that lands but whose answer times out.

import { readFileSync } from 'node:fs'

export const FARM_TASKS_CONTRACT = JSON.parse(readFileSync(new URL('../../../farm/tests/fixtures/farm_tasks_contract.json', import.meta.url), 'utf8'))

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const nonEmpty = (value) => typeof value === 'string' && value.trim() !== ''
const goodRepo = (value) => nonEmpty(value) && value.length <= 200 && value.includes('/')
const CLOSE_REASONS = ['completed', 'not_planned']

export function createFarmTasksStub({ farmUrl = 'http://farm.test', secret = 'dev-secret', configured = true } = {}) {
  const tasks = new Map() // number → task (with its repo)
  const comments = []
  const keys = new Map() // `${repo}\n${key}` → number
  let nextTask = 1
  let nextComment = 1
  let primedNumber = null
  const failures = [] // { route, status, body }
  let timeoutCreates = 0
  const calls = [] // { method, route, path, body, secretOk }
  const strays = [] // every request that was not a farm Task route
  const summaries = [] // { number, reason, summary }

  const publicTask = ({ repo, ...task }) => ({ ...task, labels: [...task.labels] })
  const publicComment = ({ repo, ...comment }) => ({ ...comment })
  const taskIn = (repo, number) => {
    const task = tasks.get(number)
    return task && task.repo === repo ? task : null
  }

  function answer(method, url, body, secretHeader) {
    const path = url.pathname
    const created = method === 'POST' && path === '/api/farm/tasks'
    const listed = method === 'GET' && path === '/api/farm/tasks'
    const commentMatch = method === 'POST' && /^\/api\/farm\/tasks\/(\d+)\/comments$/.exec(path)
    const closeMatch = method === 'POST' && /^\/api\/farm\/tasks\/(\d+)\/close$/.exec(path)
    const route = created ? 'create' : listed ? 'list' : commentMatch ? 'comment' : closeMatch ? 'close' : null
    if (!route) return null
    calls.push({ method, route, path: `${path}${url.search}`, body, secretOk: secretHeader === secret })
    if (secretHeader !== secret) return { status: 401, body: { error: 'unauthorized' } }
    if (!configured) return { status: 503, body: { error: 'task_driver_not_configured' } }
    const failure = failures.findIndex((f) => f.route === route)
    if (failure !== -1) {
      const [f] = failures.splice(failure, 1)
      return { status: f.status, body: f.body }
    }
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
    if (route === 'list') {
      const repo = url.searchParams.get('repo') ?? ''
      const after = url.searchParams.get('after_comment') ?? '0'
      if (!goodRepo(repo)) return { status: 400, body: { error: 'repo_required' } }
      if (!/^\d+$/.test(after)) return { status: 400, body: { error: 'after_comment_invalid' } }
      return {
        status: 200,
        body: {
          tasks: [...tasks.values()].filter((t) => t.repo === repo).map(publicTask),
          comments: comments.filter((c) => c.repo === repo && c.id > Number(after)).map(publicComment),
        },
      }
    }
    if (!goodRepo(b.repo)) return { status: 400, body: { error: 'repo_required' } }
    if (route === 'create') {
      const labels = b.labels ?? []
      if (!nonEmpty(b.title)) return { status: 400, body: { error: 'title_required' } }
      if (typeof (b.body ?? '') !== 'string') return { status: 400, body: { error: 'body_invalid' } }
      if (!Array.isArray(labels) || !labels.every(nonEmpty)) return { status: 400, body: { error: 'labels_invalid' } }
      if (!nonEmpty(b.idempotency_key)) return { status: 400, body: { error: 'idempotency_key_required' } }
      const known = keys.get(`${b.repo}\n${b.idempotency_key}`)
      if (known != null) return { status: 200, body: { ...publicTask(tasks.get(known)), created: false } }
      const number = primedNumber?.number ?? nextTask++
      const task = {
        number,
        url: primedNumber?.url ?? `stub://${b.repo}/tasks/${number}`,
        title: b.title,
        body: b.body ?? '',
        labels: [...labels],
        state: 'open',
        repo: b.repo,
      }
      primedNumber = null
      tasks.set(number, task)
      keys.set(`${b.repo}\n${b.idempotency_key}`, number)
      return { status: 201, body: { ...publicTask(task), created: true } }
    }
    const number = Number((commentMatch || closeMatch)[1])
    if (route === 'comment') {
      if (!nonEmpty(b.body)) return { status: 400, body: { error: 'body_required' } }
      if (!taskIn(b.repo, number)) return { status: 404, body: { error: 'task_not_found' } }
      const comment = { id: nextComment++, task: number, body: b.body, author: 'horizon', repo: b.repo }
      comments.push(comment)
      return { status: 201, body: publicComment(comment) }
    }
    if (!nonEmpty(b.summary)) return { status: 400, body: { error: 'summary_required' } }
    if (!CLOSE_REASONS.includes(b.reason)) return { status: 400, body: { error: 'reason_invalid' } }
    const task = taskIn(b.repo, number)
    if (!task) return { status: 404, body: { error: 'task_not_found' } }
    const already = task.state === 'closed'
    if (!already) {
      task.state = 'closed'
      summaries.push({ number, reason: b.reason, summary: b.summary })
    }
    return { status: 200, body: { number, state: 'closed', reason: b.reason, already_closed: already } }
  }

  async function fetchStub(input, init = {}) {
    const url = new URL(String(input))
    const method = (init.method || 'GET').toUpperCase()
    if (url.origin !== new URL(farmUrl).origin) {
      strays.push(`${method} ${url.href}`)
      throw new Error(`farm tasks stub: refused ${method} ${url.href}`)
    }
    const secretHeader = new Headers(init.headers || {}).get('x-farm-secret')
    const body = init.body == null ? undefined : JSON.parse(init.body)
    const reply = answer(method, url, body, secretHeader)
    if (!reply) {
      strays.push(`${method} ${url.href}`)
      throw new Error(`farm tasks stub: no route for ${method} ${url.pathname}`)
    }
    if (reply.status < 300 && calls.at(-1).route === 'create' && timeoutCreates > 0) {
      timeoutCreates--
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }
    return json(reply.status, reply.body)
  }

  return {
    fetch: fetchStub,
    // Replays a request straight through the route logic (for the fixture check).
    answer: (method, pathWithQuery, body, withSecret = true) => answer(method, new URL(pathWithQuery, farmUrl), body, withSecret ? secret : null),
    calls,
    strays,
    summaries,
    tasks,
    callsTo: (route) => calls.filter((c) => c.route === route),
    // A comment someone left on the Task outside Horizon.
    addOutsideComment(number, body, author = 'someone') {
      const task = tasks.get(number)
      if (!task) throw new Error(`no Task ${number}`)
      const comment = { id: nextComment++, task: number, body, author, repo: task.repo }
      comments.push(comment)
      return publicComment(comment)
    },
    setState(number, state) {
      tasks.get(number).state = state
    },
    // The repo's Task list is exactly these issue-shaped entries.
    seedTasks(repo, issues) {
      for (const [n, t] of tasks) if (t.repo === repo) tasks.delete(n)
      for (const issue of issues) {
        tasks.set(issue.number, {
          number: issue.number,
          url: issue.html_url ?? issue.url,
          title: issue.title,
          body: issue.body ?? '',
          labels: (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
          state: issue.state ?? 'open',
          repo,
        })
      }
    },
    primeNextTask(number, url) {
      primedNumber = { number, url }
    },
    failNext(route, status, body) {
      failures.push({ route, status, body })
    },
    // The next create lands in the farm, but its answer never arrives.
    timeoutNextCreate() {
      timeoutCreates++
    },
  }
}
