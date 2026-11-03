// Preloaded with `node --import` so a real CLI run of publish.mjs talks to
// the stub GitHub instead of the network. Each fetch call, and any read of
// process.env.GITHUB_TOKEN, is appended as a JSON line to $STUB_GITHUB_LOG.
// A write's line also holds its body keys and its author and committer.
// The scenario comes from $STUB_GITHUB_SCENARIO (stubGitHub options as JSON).

import { appendFileSync, writeFileSync } from 'node:fs'
import { stubGitHub } from './stub-github.mjs'

const log = process.env.STUB_GITHUB_LOG
const stub = stubGitHub(JSON.parse(process.env.STUB_GITHUB_SCENARIO || '{}'))
const record = (entry) => appendFileSync(log, `${JSON.stringify(entry)}\n`)
writeFileSync(log, '')

globalThis.fetch = (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : null
  record({ fetch: (init.method ?? 'GET').toUpperCase(), url: String(url), ...(body ? { bodyKeys: Object.keys(body), author: body.author ?? null, committer: body.committer ?? null } : {}) })
  return stub.fetch(url, init)
}

const realEnv = process.env
process.env = new Proxy(realEnv, {
  get(target, key) {
    if (key === 'GITHUB_TOKEN') record({ envRead: key })
    return Reflect.get(target, key)
  },
})
