// HZ-333: a fetch stub for the deploy queue tests. GitHub answers PR merge
// commits, main's head, release lookups/creates and commit comparisons from
// in-memory state; any other host (the farm) is recorded as a dispatch.

export const shaOf = (n) => Number(n).toString(16).padStart(40, 'c')

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

export function deployQueueStub({ mainSha = shaOf(0xa0), releases = [] } = {}) {
  const stub = {
    mainSha,
    prs: new Map(), // "<repo>#<pr>" -> merge sha
    releases: new Map(releases.map((r) => [`${r.repo}@${r.tag_name}`, r])),
    posts: [], // release POST bodies, with repo
    requests: [], // every GitHub call: { method, path }
    dispatches: [], // farm calls: { path, body }
    // (base, head) -> a compare status, or an HTTP status number to fail with.
    compare: () => 'ahead',
  }
  stub.fetch = async (url, opts = {}) => {
    const u = new URL(String(url))
    const method = opts.method || 'GET'
    const body = opts.body ? JSON.parse(opts.body) : null
    if (u.hostname !== 'api.github.com') {
      stub.dispatches.push({ path: u.pathname, body })
      return json(200, {})
    }
    stub.requests.push({ method, path: u.pathname })
    let m
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(u.pathname))) {
      const merge = stub.prs.get(`${m[1]}#${m[2]}`)
      return merge ? json(200, { merged: true, merge_commit_sha: merge }) : json(404, {})
    }
    if (/\/git\/ref\/heads(%2F|\/)main$/.test(u.pathname)) return json(200, { object: { sha: stub.mainSha } })
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/releases\/tags\/(.+)$/.exec(u.pathname))) {
      const release = stub.releases.get(`${m[1]}@${decodeURIComponent(m[2])}`)
      return release ? json(200, release) : json(404, {})
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/releases$/.exec(u.pathname)) && method === 'POST') {
      const release = { repo: m[1], ...body, html_url: `https://github.com/${m[1]}/releases/tag/${body.tag_name}` }
      stub.posts.push(release)
      stub.releases.set(`${m[1]}@${body.tag_name}`, release)
      return json(201, release)
    }
    if ((m = /\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(u.pathname))) {
      const answer = stub.compare(m[1], m[2])
      return typeof answer === 'number' ? json(answer, {}) : json(200, { status: answer })
    }
    return json(200, {})
  }
  return stub
}
