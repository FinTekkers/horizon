import { PublishError, redact } from './errors.mjs'
import { IDENTITY, IDENTITY_LINE, isIdentity, personLine } from './identity.mjs'

// The only account and repo this tool ever writes to. There is no flag or
// option to change them.
export const OWNER = 'ParvatiRealEstate'
export const REPO = 'parvati-site'
export const API = 'https://api.github.com'
export const REPO_PATH = `/repos/${OWNER}/${REPO}`
export const CREATE_PATHS = { Organization: `/orgs/${OWNER}/repos`, User: '/user/repos' }
export const WRITE_METHODS = ['POST', 'PUT', 'PATCH']
// Create-repo keys that make GitHub write a first commit as the token's user.
export const FIRST_COMMIT_KEYS = ['auto_init', 'gitignore_template', 'license_template']

export const sameLogin = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()

// Guardrail 4, enforced before fetch is called: writes go to api.github.com,
// under REPO_PATH or to one of the two create-repo paths. DELETE is never
// sent and no body may carry force: true. The check runs on the normalised
// URL, so "..", "%2e%2e" and look-alike repo names cannot slip through.
// HZ-725: the two calls that make a commit (POST git/commits and PUT
// contents/...) must carry author and committer equal to IDENTITY, and a
// create-repo call may not ask GitHub for a first commit of its own.
export function checkWrite(method, url, body) {
  if (method === 'DELETE') throw new PublishError('refused: this tool never sends DELETE')
  if (!WRITE_METHODS.includes(method) && method !== 'GET') throw new PublishError(`refused: unexpected method ${method}`)
  if (url.origin !== API) throw new PublishError(`refused: ${method} to ${url.origin} (only ${API} is allowed)`)
  if (method === 'GET') return
  if (body && body.force === true) throw new PublishError('refused: this tool never force-pushes')
  const p = url.pathname
  if (Object.values(CREATE_PATHS).includes(p) && body && FIRST_COMMIT_KEYS.some((k) => Object.hasOwn(body, k))) {
    throw new PublishError('refused: create-repo call asks GitHub for a first commit (auto_init or a template)')
  }
  const commitCall = (method === 'POST' && [`${REPO_PATH}/git/commits`, `${REPO_PATH}/git/commits/`].includes(p))
    || (method === 'PUT' && p.startsWith(`${REPO_PATH}/contents/`))
  if (commitCall && !(isIdentity(body?.author) && isIdentity(body?.committer))) {
    throw new PublishError(`refused: commit call without the ${IDENTITY.name} author and committer`)
  }
  if (p.startsWith(`${REPO_PATH}/`) || Object.values(CREATE_PATHS).includes(p)) return
  throw new PublishError(`refused: ${method} ${p} is outside ${OWNER}/${REPO}`)
}

// GitHub's record of a commit this tool made, as { sha, author, committer }
// lines. Stops the run if GitHub stored any identity other than IDENTITY. The
// stored identity is never printed: it could be the token owner's.
function pushedCommit(commit, where) {
  const author = personLine(commit?.author)
  const committer = personLine(commit?.committer)
  if (!commit?.sha || author !== IDENTITY_LINE || committer !== IDENTITY_LINE) {
    throw new PublishError(`GitHub stored the commit from ${where} under a different author or committer than ${IDENTITY_LINE}. Stopped before any other write.`)
  }
  return { sha: commit.sha, author, committer }
}

// The GitHub REST client. The token goes only in the Authorization header of
// requests to api.github.com, never in a URL, and never in an error message.
export function createGitHub({ token, fetch }) {
  async function request(method, pathOrUrl, body, okStatuses = []) {
    const url = new URL(pathOrUrl, API)
    checkWrite(method, url, body)
    const where = `${method} ${url.pathname}`
    let res
    try {
      res = await fetch(url.href, {
        method,
        redirect: 'error',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'horizon-tenant-sites-publish',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      throw new PublishError(redact(`GitHub ${where} failed: ${err?.message ?? err}`, [token]))
    }
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (res.ok || okStatuses.includes(res.status)) return { status: res.status, data }
    const detail = data?.message ? `: ${data.message}` : ''
    throw new PublishError(redact(`GitHub ${where} failed: HTTP ${res.status}${detail}`, [token]))
  }

  const orNull = async (method, path, statuses) => {
    const r = await request(method, path, undefined, statuses)
    return statuses.includes(r.status) ? null : r.data
  }
  const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/')

  return {
    request,
    // Reads.
    getOwner: async () => (await request('GET', `/users/${OWNER}`)).data,
    getTokenLogin: async () => (await request('GET', '/user')).data?.login,
    getRepo: () => orNull('GET', REPO_PATH, [404]),
    // 409 is GitHub's answer for an empty repo; 404 for a missing branch.
    getRef: async (branch) => (await orNull('GET', `${REPO_PATH}/git/ref/heads/${encodePath(branch)}`, [404, 409]))?.object?.sha ?? null,
    getCommit: async (sha) => (await request('GET', `${REPO_PATH}/git/commits/${sha}`)).data,
    getTree: async (sha) => (await request('GET', `${REPO_PATH}/git/trees/${sha}?recursive=1`)).data,
    getPages: () => orNull('GET', `${REPO_PATH}/pages`, [404]),
    latestBuild: () => orNull('GET', `${REPO_PATH}/pages/builds/latest`, [404]),
    // Writes. Each one goes through checkWrite() inside request().
    createRepo: async (ownerType) => {
      const p = Object.hasOwn(CREATE_PATHS, ownerType) ? CREATE_PATHS[ownerType] : null
      if (!p) throw new PublishError(`${OWNER} has unexpected account type ${ownerType}`)
      return (await request('POST', p, { name: REPO, private: false })).data
    },
    // The first commit of an empty repo. Returns { commit, content }.
    putFirstFile: async (file, branch) => {
      const data = (await request('PUT', `${REPO_PATH}/contents/${encodePath(file.path)}`, {
        message: `Publish ${REPO}: first file`,
        content: file.content.toString('base64'),
        branch,
        author: IDENTITY,
        committer: IDENTITY,
      })).data
      return { commit: pushedCommit(data?.commit, 'the first-file PUT'), content: data?.content }
    },
    createBlob: async (content) => (await request('POST', `${REPO_PATH}/git/blobs`, { content: content.toString('base64'), encoding: 'base64' })).data.sha,
    createTree: async (entries) => (await request('POST', `${REPO_PATH}/git/trees`, { tree: entries })).data.sha,
    // Returns { sha, author, committer }.
    createCommit: async (message, tree, parent) => pushedCommit((await request('POST', `${REPO_PATH}/git/commits`, {
      message,
      tree,
      parents: [parent],
      author: IDENTITY,
      committer: IDENTITY,
    })).data, 'POST git/commits'),
    updateRef: async (branch, sha) => {
      const r = await request('PATCH', `${REPO_PATH}/git/refs/heads/${encodePath(branch)}`, { sha, force: false }, [422])
      if (r.status === 422) {
        throw new PublishError(`${branch} moved on GitHub while publishing (not a fast-forward). Nothing was overwritten; run the command again.`)
      }
    },
    enablePages: async (branch) => (await request('POST', `${REPO_PATH}/pages`, { source: { branch, path: '/' } })).data,
  }
}

// GETs the published site with no Authorization header: the token never
// leaves api.github.com. Returns the body bytes, or null on any failure so
// the caller can retry while the Pages CDN catches up.
export async function fetchServed(fetch, url) {
  try {
    const res = await fetch(url, { method: 'GET', headers: { 'Cache-Control': 'no-cache' } })
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
}
