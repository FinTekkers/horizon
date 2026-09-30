// HZ-113/HZ-114: the ingest-time 500-char slice on work_item.desc used to
// live in store.js's parseIssueBody, called from upsertFromGithub, called
// from the real /api/webhooks/github route. store.test.mjs already proves
// parseIssueBody itself keeps text past char 500; this file proves the same
// thing through the actual HTTP path a live GitHub webhook uses — real HMAC
// signature verification, the real route handler, a real connected repo, a
// real DB round trip — the flow the unit test can't reach on its own.
//
// Kept in its own file (same reason as webhook-deploy.test.mjs): needs
// GITHUB_WEBHOOK_SECRET set before config.js/app.js are imported, and its
// own temp DB so it doesn't collide with other suites' fixtures.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-webhook-issue-')), 'test.db')
process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret'
delete process.env.FARM_URL

const { buildApp } = await import('../src/app.js')
const store = await import('../src/store.js')

const app = buildApp({ logger: false })

function sign(body) {
  return 'sha256=' + crypto.createHmac('sha256', 'test-webhook-secret').update(body).digest('hex')
}

function issuesWebhook(repo, issue) {
  const body = JSON.stringify({ action: 'opened', repository: { full_name: repo }, issue })
  return app.inject({
    method: 'POST',
    url: '/api/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-hub-signature-256': sign(body),
    },
    payload: body,
  })
}

const { id: projectId } = store.createProject('HZ-113 webhook fixture project')
const REPO = 'FinTekkers/hz-113-fixture-repo'
const connected = store.addRepoToProject(projectId, REPO)
assert.ok(connected.ok, `fixture repo must connect cleanly: ${JSON.stringify(connected)}`)

test('a real GitHub "issues" webhook keeps an outcome whose operative detail sits past char 500 (HZ-113)', async () => {
  const filler = 'x'.repeat(480)
  const body = `## Outcome\n${filler} the required filename is REQUIRED-FILENAME-PAST-CHAR-500.txt`

  const res = await issuesWebhook(REPO, { number: 4113, title: 'HZ-113 webhook fixture issue', body, labels: [] })
  assert.equal(res.statusCode, 204)

  const id = `${connected.prefix}-4113`
  const item = store.getItem(id)
  assert.ok(item, `webhook must have created ${id}`)
  assert.ok(
    item.desc.includes('REQUIRED-FILENAME-PAST-CHAR-500.txt'),
    'operative detail past char 500 must survive a real webhook ingest intact, not be silently dropped',
  )
  assert.equal(item.desc.length, body.length - '## Outcome\n'.length)
})
