// HZ-510: an in-memory stand-in for GitHub's git data API — refs, commits,
// trees and blobs — strict where promotion depends on it: a PATCH with
// force: false is refused (422) unless the new commit descends from the
// current head, POST /git/refs is refused when the ref exists, and a tree
// entry deleting (sha: null) a path missing from base_tree is refused. Every
// write is recorded in `writes`.

import { createHash } from 'node:crypto'

const sha1 = (s) => createHash('sha1').update(s).digest('hex')
// github.js caches trees per commit sha for the whole process, so commit and
// tree shas must never repeat across fakes.
let fakes = 0

export function fakeGit(repo) {
  const git = {
    refs: new Map(), // 'heads/<name>' → commit sha
    commits: new Map(), // sha → { tree, parents }
    trees: new Map(), // sha → Map(path → blob sha)
    blobs: new Map(), // sha → Buffer
    calls: [],
    writes: [],
    // Called (and cleared) just before the next baseline PATCH / ref POST,
    // so a test can land another item's promotion in between.
    beforeMove: null,
    // 'METHOD /git/<kind>' → status to answer with instead.
    fail: {},
  }
  const nonce = `fake${fakes++}`
  let seq = 0

  git.blob = (label) => {
    const bytes = Buffer.from(String(label))
    const sha = sha1(`blob ${bytes.length}\0${bytes}`)
    git.blobs.set(sha, bytes)
    return sha
  }
  git.tree = (files) => {
    const map = new Map(Object.entries(files))
    const sha = sha1(`tree ${nonce} ${seq++}`)
    git.trees.set(sha, map)
    return sha
  }
  // files: path → blob sha
  git.commit = (files, parents = []) => {
    const sha = sha1(`commit ${nonce} ${seq++}`)
    git.commits.set(sha, { tree: git.tree(files), parents })
    return sha
  }
  git.filesAt = (ref) => {
    const head = git.refs.get(`heads/${ref}`)
    return head ? Object.fromEntries(git.trees.get(git.commits.get(head).tree)) : null
  }
  const descends = (sha, ancestor) => {
    if (sha === ancestor) return true
    return (git.commits.get(sha)?.parents ?? []).some((p) => descends(p, ancestor))
  }

  git.fetch = async (url, options = {}) => {
    const u = new URL(url)
    const method = options.method || 'GET'
    const body = options.body ? JSON.parse(options.body) : undefined
    const path = decodeURIComponent(u.pathname.slice(`/repos/${repo}`.length))
    git.calls.push({ method, path, body })
    if (method !== 'GET') git.writes.push({ method, path, body })
    const json = (status, data = {}) => ({ ok: status < 300, status, json: async () => data })
    const kind = path.match(/^\/git\/(\w+)/)?.[1]
    if (git.fail[`${method} /git/${kind}`]) return json(git.fail[`${method} /git/${kind}`], { message: 'injected' })
    let m
    if (method === 'GET' && (m = path.match(/^\/git\/ref\/(.+)$/))) {
      const sha = git.refs.get(m[1])
      return sha ? json(200, { ref: `refs/${m[1]}`, object: { sha } }) : json(404, { message: 'Not Found' })
    }
    if (method === 'GET' && (m = path.match(/^\/git\/commits\/([0-9a-f]{40})$/))) {
      const c = git.commits.get(m[1])
      return c ? json(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })) }) : json(404)
    }
    if (method === 'GET' && (m = path.match(/^\/git\/trees\/([0-9a-f]{40})$/))) {
      const t = git.trees.get(m[1])
      if (!t) return json(404)
      const tree = [...t].map(([p, sha]) => ({ path: p, mode: '100644', type: 'blob', sha, size: git.blobs.get(sha)?.length ?? 0 }))
      return json(200, { sha: m[1], tree, truncated: false })
    }
    if (method === 'GET' && (m = path.match(/^\/git\/blobs\/([0-9a-f]{40})$/))) {
      const bytes = git.blobs.get(m[1])
      if (!bytes) return json(404)
      return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }
    }
    if (method === 'POST' && path === '/git/trees') {
      const files = body.base_tree ? new Map(git.trees.get(body.base_tree)) : new Map()
      if (body.base_tree && !git.trees.has(body.base_tree)) return json(422, { message: 'base_tree not found' })
      for (const entry of body.tree) {
        if (entry.sha === null) {
          if (!files.has(entry.path)) return json(422, { message: `GitHub cannot delete missing ${entry.path}` })
          files.delete(entry.path)
        } else {
          if (!git.blobs.has(entry.sha)) return json(422, { message: `no blob ${entry.sha}` })
          files.set(entry.path, entry.sha)
        }
      }
      return json(201, { sha: git.tree(Object.fromEntries(files)) })
    }
    if (method === 'POST' && path === '/git/commits') {
      if (!git.trees.has(body.tree) || body.parents.some((p) => !git.commits.has(p))) return json(422, { message: 'bad commit' })
      const sha = sha1(`commit ${nonce} ${seq++}`)
      git.commits.set(sha, { tree: body.tree, parents: body.parents })
      return json(201, { sha })
    }
    if ((method === 'PATCH' || method === 'POST') && path.startsWith('/git/refs') && git.beforeMove) {
      const hook = git.beforeMove
      git.beforeMove = null
      hook()
    }
    if (method === 'POST' && path === '/git/refs') {
      const name = body.ref.replace(/^refs\//, '')
      if (git.refs.has(name)) return json(422, { message: 'Reference already exists' })
      git.refs.set(name, body.sha)
      return json(201, { ref: body.ref, object: { sha: body.sha } })
    }
    if (method === 'PATCH' && (m = path.match(/^\/git\/refs\/(.+)$/))) {
      const head = git.refs.get(m[1])
      if (!head) return json(422, { message: 'Reference does not exist' })
      if (!body.force && !descends(body.sha, head)) return json(422, { message: 'Update is not a fast forward' })
      git.refs.set(m[1], body.sha)
      return json(200, { object: { sha: body.sha } })
    }
    if (method === 'DELETE' && (m = path.match(/^\/git\/refs\/(.+)$/))) {
      if (!git.refs.delete(m[1])) return json(422, { message: 'Reference does not exist' })
      return { ok: true, status: 204, json: async () => ({}) }
    }
    if (method === 'PUT' && /^\/pulls\/\d+\/merge$/.test(path)) return json(200, { merged: true })
    return json(404, { message: 'Not Found' })
  }
  return git
}
