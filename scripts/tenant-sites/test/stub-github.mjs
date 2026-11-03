// A stateful fake of the GitHub REST endpoints publish.mjs uses, plus the
// Pages site itself. It records every call and fails closed: any request it
// does not recognise throws, so nothing in a test can reach the network.
// Options are plain JSON so test/record-fetch.mjs can pass them to a CLI run.

import { createHash } from 'node:crypto'
import { blobSha } from '../publish/lib/files.mjs'

export const OWNER = 'ParvatiRealEstate'
export const REPO = 'parvati-site'
export const API = 'https://api.github.com'
export const REPO_PATH = `/repos/${OWNER}/${REPO}`
export const PAGES_URL = `https://${OWNER.toLowerCase()}.github.io/${REPO}/`
export const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const sha1 = (text) => createHash('sha1').update(text).digest('hex')
const json = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// repo: null (missing), { empty: true }, or { files: { path: text } } plus
// optional private / visibility / admin / defaultBranch.
// builds / served: values returned, in order, by pages/builds/latest and the
// Pages site before the stub falls back to the truth. 'HEAD' stands for the
// current ref. fail: { 'METHOD /path': { status, message } | { reject } }.
export function stubGitHub({
  ownerType = 'Organization',
  tokenLogin = OWNER,
  createdOwner = OWNER,
  repo = null,
  pages = false,
  builds = [],
  served = [],
  fail = {},
} = {}) {
  const calls = []
  const blobs = new Map()
  const trees = new Map()
  const commits = new Map()
  let counter = 0
  let ref = null
  let repoInfo = null
  let pagesOn = false
  builds = [...builds]
  served = [...served]

  const putBlob = (bytes) => {
    const sha = blobSha(bytes)
    blobs.set(sha, bytes)
    return sha
  }
  const putTree = (entries) => {
    const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))
    const sha = sha1(`tree\n${sorted.map((e) => `${e.mode} ${e.path} ${e.sha}`).join('\n')}`)
    trees.set(sha, sorted)
    return sha
  }
  const putCommit = (tree, parents) => {
    const sha = sha1(`commit ${tree} ${parents.join(',')} ${++counter}`)
    commits.set(sha, { tree, parents })
    return sha
  }
  const makeRepo = (opts = {}) => {
    repoInfo = {
      name: REPO,
      full_name: `${OWNER}/${REPO}`,
      owner: { login: OWNER },
      private: Boolean(opts.private),
      visibility: opts.visibility ?? (opts.private ? 'private' : 'public'),
      default_branch: opts.defaultBranch ?? 'main',
      html_url: `https://github.com/${OWNER}/${REPO}`,
      permissions: { admin: opts.admin ?? true, push: true, pull: true },
    }
  }
  const commitFiles = (files, parents = []) => {
    const entries = Object.entries(files).map(([path, text]) => ({ path, mode: '100644', type: 'blob', sha: putBlob(Buffer.from(text)) }))
    ref = putCommit(putTree(entries), parents)
  }
  const headFiles = () => (ref ? trees.get(commits.get(ref).tree) : [])

  if (repo) {
    makeRepo(repo)
    if (!repo.empty) commitFiles(repo.files ?? { 'README.md': '# parvati-site\n' })
  }
  if (pages) pagesOn = true

  function route(method, url, body) {
    const p = url.pathname
    if (url.origin === new URL(PAGES_URL).origin) {
      if (method !== 'GET' || p !== new URL(PAGES_URL).pathname || !pagesOn) return new Response('not found', { status: 404 })
      const next = served.length ? served.shift() : null
      if (next !== null) return new Response(next, { status: 200 })
      const index = headFiles().find((e) => e.path === 'index.html')
      return index ? new Response(blobs.get(index.sha), { status: 200 }) : new Response('not found', { status: 404 })
    }
    if (url.origin !== API) return undefined

    if (method === 'GET' && p === `/users/${OWNER}`) return json(200, { login: OWNER, type: ownerType })
    if (method === 'GET' && p === '/user') return json(200, { login: tokenLogin })
    if (method === 'POST' && (p === `/orgs/${OWNER}/repos` || p === '/user/repos')) {
      makeRepo()
      repoInfo.owner = { login: createdOwner }
      if (body.auto_init) commitFiles({ 'README.md': '# parvati-site\n' })
      return json(201, repoInfo)
    }
    if (method === 'GET' && p === REPO_PATH) return repoInfo ? json(200, repoInfo) : json(404, { message: 'Not Found' })
    if (!repoInfo || !p.startsWith(`${REPO_PATH}/`)) return undefined

    const rest = p.slice(REPO_PATH.length + 1)
    const branchRef = `git/ref/heads/${repoInfo.default_branch}`
    if (method === 'GET' && rest === branchRef) {
      return ref ? json(200, { object: { sha: ref, type: 'commit' } }) : json(409, { message: 'Git Repository is empty.' })
    }
    if (method === 'GET' && rest.startsWith('git/commits/')) {
      const c = commits.get(rest.slice('git/commits/'.length))
      return c ? json(200, { tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })) }) : json(404, { message: 'Not Found' })
    }
    if (method === 'GET' && rest.startsWith('git/trees/')) {
      const entries = trees.get(rest.slice('git/trees/'.length))
      if (!entries) return json(404, { message: 'Not Found' })
      // Like GitHub's recursive listing: directories appear as type "tree".
      const dirs = new Set(entries.flatMap((e) => e.path.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))))
      return json(200, { tree: [...[...dirs].map((d) => ({ path: d, mode: '040000', type: 'tree' })), ...entries], truncated: false })
    }
    if (method === 'PUT' && rest.startsWith('contents/')) {
      if (ref) return json(422, { message: 'stub: contents PUT is only used on an empty repo' })
      const path = decodeURIComponent(rest.slice('contents/'.length))
      commitFiles({ [path]: Buffer.from(body.content, 'base64') })
      return json(201, { content: { path, sha: headFiles()[0].sha }, commit: { sha: ref } })
    }
    if (method === 'POST' && rest === 'git/blobs') return json(201, { sha: putBlob(Buffer.from(body.content, 'base64')) })
    if (method === 'POST' && rest === 'git/trees') {
      if (body.base_tree) return json(422, { message: 'stub: base_tree is not expected' })
      for (const e of body.tree) if (!blobs.has(e.sha)) return json(422, { message: `stub: unknown blob for ${e.path}` })
      return json(201, { sha: putTree(body.tree) })
    }
    if (method === 'POST' && rest === 'git/commits') {
      if (!trees.has(body.tree)) return json(422, { message: 'stub: unknown tree' })
      return json(201, { sha: putCommit(body.tree, body.parents) })
    }
    if (method === 'PATCH' && rest === `git/refs/heads/${repoInfo.default_branch}`) {
      const c = commits.get(body.sha)
      if (!c || (!body.force && c.parents[0] !== ref)) return json(422, { message: 'Update is not a fast forward' })
      ref = body.sha
      return json(200, { object: { sha: ref } })
    }
    if (method === 'GET' && rest === 'pages') {
      return pagesOn ? json(200, { html_url: PAGES_URL, build_type: 'legacy', source: { branch: repoInfo.default_branch, path: '/' } }) : json(404, { message: 'Not Found' })
    }
    if (method === 'POST' && rest === 'pages') {
      if (pagesOn) return json(409, { message: 'GitHub Pages is already enabled.' })
      pagesOn = true
      return json(201, { html_url: PAGES_URL, build_type: 'legacy', source: body.source })
    }
    if (method === 'GET' && rest === 'pages/builds/latest') {
      if (!pagesOn) return json(404, { message: 'Not Found' })
      const next = builds.length ? builds.shift() : { status: 'built', commit: 'HEAD' }
      return json(200, { ...next, commit: next.commit === 'HEAD' ? ref : next.commit })
    }
    return undefined
  }

  async function fetch(input, init = {}) {
    const url = new URL(String(input))
    const method = (init.method ?? 'GET').toUpperCase()
    const body = init.body ? JSON.parse(init.body) : undefined
    const headers = init.headers ?? {}
    calls.push({ method, url: url.href, host: url.host, path: url.pathname, body, authorization: headers.Authorization ?? headers.authorization ?? null })
    const injected = fail[`${method} ${url.pathname}`]
    if (injected?.reject) throw new Error(injected.reject)
    if (injected) return json(injected.status, { message: injected.message })
    const res = route(method, url, body)
    if (!res) throw new Error(`stub-github: unmatched request ${method} ${url.href}`)
    return res
  }

  return {
    fetch,
    calls,
    writes: () => calls.filter((c) => WRITE.has(c.method)),
    headFiles,
    blob: (sha) => blobs.get(sha),
    get ref() { return ref },
  }
}
