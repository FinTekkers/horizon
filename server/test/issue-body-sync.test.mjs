// Agent refinements (outcome / metric / guardrails) must reach the GitHub issue
// body: store.upsertFromGithub() re-reads those sections from the body on every
// issue webhook, and the step comment posted after a patch fires one, so a
// database-only refinement was overwritten seconds later (HZ-204, HZ-216).

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-issue-body-')), 'test.db')

const { composeIssueBody, syncIssueBodyFields } = await import('../src/github.js')
const { parseIssueBody } = await import('../src/store.js')

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function stubGitHub(initialBody) {
  const calls = []
  let body = initialBody
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null })
    if ((opts.method || 'GET') === 'PATCH') body = JSON.parse(opts.body).body
    return { ok: true, status: 200, json: async () => ({ body }) }
  }
  return { calls, current: () => body }
}

const item = {
  id: 'HZ-9',
  repo: 'acme/app',
  issue: 9,
  desc: 'An outcome.',
  metric: '- Refined metric line, written by the PM.',
  guardrails: '- A guardrail.',
}

test('a Horizon-format issue body is rewritten with the refined metric, so the next webhook keeps it', async () => {
  const gh = stubGitHub(composeIssueBody({ outcome: 'An outcome.', metric: '- Original metric line.', guardrails: '- A guardrail.' }))
  assert.equal(await syncIssueBodyFields(item), true)
  const patch = gh.calls.find((c) => c.method === 'PATCH')
  assert.ok(patch, 'no PATCH sent')
  assert.match(patch.url, /\/repos\/acme\/app\/issues\/9$/)
  assert.match(gh.current(), /Refined metric line, written by the PM\./)
  assert.doesNotMatch(gh.current(), /Original metric line/)
  assert.equal(parseIssueBody(gh.current()).metric.trim(), item.metric)
})

test('an issue written freehand on GitHub (no Horizon headings) is never rewritten', async () => {
  const gh = stubGitHub('Please make the board faster.\n\nThanks!')
  assert.equal(await syncIssueBodyFields(item), false)
  assert.equal(gh.calls.filter((c) => c.method === 'PATCH').length, 0)
})

test('an unchanged body sends no PATCH', async () => {
  const same = composeIssueBody({ outcome: item.desc, metric: item.metric, guardrails: item.guardrails })
  const gh = stubGitHub(same)
  assert.equal(await syncIssueBodyFields(item), false)
  assert.equal(gh.calls.filter((c) => c.method === 'PATCH').length, 0)
})

test('an item with no linked issue is skipped without any request', async () => {
  const gh = stubGitHub('')
  assert.equal(await syncIssueBodyFields({ ...item, issue: null }), false)
  assert.equal(gh.calls.length, 0)
})
