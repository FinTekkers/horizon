// HZ-313: a stateful GitHub + farm stub for the split tests. Every outbound
// call is recorded; issues live in memory per repo, so the list endpoint
// returns what a create POST made. Hooks let a test delay, fail or react to
// a create (e.g. the webhook syncing the issue in first).

export function splitGithubStub() {
  const calls = []
  const issues = new Map() // repo -> [issue]
  const hooks = {
    createStatus: {}, // repo -> HTTP status to fail creates with
    patchStatus: {}, // repo -> HTTP status to fail PATCHes with
    beforeCreate: null, // async (repo) => void, awaited before the issue exists
    afterCreate: null, // (repo, issue) => void
  }
  let nextNumber = 500

  const respond = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
  const repoIssues = (repo) => {
    if (!issues.has(repo)) issues.set(repo, [])
    return issues.get(repo)
  }

  function addIssue(repo, fields) {
    const number = fields.number ?? nextNumber++
    const issue = {
      number,
      title: fields.title || `Issue ${number}`,
      body: fields.body || '',
      state: fields.state || 'open',
      labels: [],
      html_url: `https://github.com/${repo}/issues/${number}`,
      updated_at: new Date().toISOString(),
    }
    repoIssues(repo).push(issue)
    return issue
  }

  async function fetch(url, opts = {}) {
    const u = new URL(String(url))
    const method = (opts.method || 'GET').toUpperCase()
    const body = opts.body ? JSON.parse(opts.body) : null
    calls.push({ method, url: String(url), path: u.pathname, body, headers: opts.headers || {} })
    // The farm: up, and accepting every dispatch.
    if (u.hostname !== 'api.github.com') return respond(200, { status: 'running' })

    const m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/(labels|issues)(?:\/(\d+))?(\/comments)?$/)
    if (!m) return respond(200, {})
    const [, repo, kind, number, comments] = m
    if (kind === 'labels') return respond(201, {})
    if (comments) return respond(201, {})
    if (method === 'POST' && !number) {
      if (hooks.beforeCreate) await hooks.beforeCreate(repo)
      if (hooks.createStatus[repo]) return respond(hooks.createStatus[repo], { message: 'nope' })
      const issue = addIssue(repo, { title: body.title, body: body.body })
      hooks.afterCreate?.(repo, issue)
      return respond(201, issue)
    }
    if (method === 'GET' && !number) return respond(200, repoIssues(repo))
    const issue = repoIssues(repo).find((i) => i.number === Number(number))
    if (!issue) return respond(404, { message: 'Not Found' })
    if (method === 'PATCH') {
      if (hooks.patchStatus[repo]) return respond(hooks.patchStatus[repo], { message: 'nope' })
      Object.assign(issue, body)
      return respond(200, issue)
    }
    return respond(200, issue)
  }

  // Create-issue POSTs (labels and comments excluded), optionally for one repo.
  const creates = (repo = null) =>
    calls.filter(
      (c) => c.method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/issues$/.test(c.path) && (!repo || c.path.startsWith(`/repos/${repo}/`)),
    )

  return { fetch, calls, issues, hooks, addIssue, creates, repoIssues }
}
