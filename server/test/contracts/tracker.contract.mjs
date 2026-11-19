// HO-871: the shared Tracker port contract. Every backend adapter that
// forRepo(repo).tracker can hand out runs this same suite — the GitHub adapter
// in test/tracker-contract-github.test.mjs today, the sl adapter (HO-875)
// next. A helper, not a test file: `npm test` globs test/*.test.mjs only, so it
// runs only when an adapter's own test file calls runTrackerContract().
//
// The port's result type, as HO-871 leaves it (GitHub-shaped on purpose — the
// adapter is a pure re-export of github.js, and its callers read these
// fields):
//
//   createIssue(repo, fields)     → Promise<Issue>, Issue = { number, html_url, ... }
//                                    number: a positive integer, the item id's
//                                    suffix (`<prefix>-<number>`); html_url: the
//                                    issue's link, returned unchanged.
//   findSplitIssue(repo, marker, since) → Promise<Issue | null>
//   closeIssueWithSummary(item)   → Promise; rejects when the tracker refuses,
//                                    and the error reaches the caller.
//   pollRepo(repo, log)           → Promise<{ changed: number, ... }>
//   ingestIssue(issue, repo)      → truthy when an item changed; falsy (a no-op)
//                                    for a repo Horizon does not track.
//   ingestComment(repo, issueNumber, comment, log) → truthy for a new feedback
//                                    row; falsy for an issue Horizon does not track.
//
// makeHarness() is called once per case and returns:
//   tracker            the adapter under test
//   repo               a repo the adapter may act on (need not be connected)
//   item               an item on `repo` with an issue: { id, repo, issue, ... }
//   primeCreate(issue) the next createIssue answers with `issue`
//   primeIssues(list)  the repo's issue listing (findSplitIssue, pollRepo) is `list`
//   primeCloseFailure() the next close is refused by the tracker
//   restore()          undoes everything the harness changed
//   violations()       (optional) problems the harness saw, e.g. a live call
//                      or a wrong credential; must be [] after every case

import { test } from 'node:test'
import assert from 'node:assert/strict'

// The Tracker port: every method forRepo(repo).tracker carries.
export const TRACKER_METHODS = Object.freeze([
  'createIssue',
  'postIssueComment',
  'closeIssueWithSummary',
  'closeIssueAsAbandoned',
  'syncIssueBodyFields',
  'pushIssueScope',
  'getIssueBody',
  'patchIssueBodyLines',
  'setPriorityLabel',
  'setAutopilotOffLabel',
  'findSplitIssue',
  'pollRepo',
  'pollComments',
  'ingestIssue',
  'ingestComment',
  'pollOnce',
  'startPolling',
  'getSyncState',
  // HZ-921: the item's one stats comment (tracker-port.contract.mjs).
  'upsertStatsComment',
])

const quietLog = { info() {}, warn() {}, error() {}, debug() {} }

export function runTrackerContract(name, makeHarness) {
  const contractCase = (title, body) =>
    test(`tracker contract (${name}): ${title}`, async () => {
      const harness = await makeHarness()
      try {
        await body(harness)
        assert.deepEqual(harness.violations?.() ?? [], [], 'the harness saw no live call or wrong credential')
      } finally {
        await harness.restore()
      }
    })

  contractCase('carries exactly the port methods, each a function', ({ tracker }) => {
    assert.deepEqual(Object.keys(tracker).sort(), [...TRACKER_METHODS].sort())
    for (const method of TRACKER_METHODS) assert.equal(typeof tracker[method], 'function', method)
  })

  contractCase('createIssue resolves to the issue with its number and link unchanged', async (h) => {
    h.primeCreate({ number: 4321, html_url: `https://tracker.test/${h.repo}/issues/4321`, title: 'Contract issue', body: '', labels: [], state: 'open' })
    const issue = await h.tracker.createIssue(h.repo, {
      title: 'Contract issue',
      outcome: 'The contract holds.',
      metric: 'One line.',
      guardrails: 'No live calls.',
      priority: 'Medium',
    })
    assert.equal(typeof issue, 'object')
    assert.ok(Number.isInteger(issue.number) && issue.number > 0, `number: ${issue.number}`)
    assert.equal(issue.number, 4321)
    assert.equal(typeof issue.html_url, 'string')
    assert.equal(issue.html_url, `https://tracker.test/${h.repo}/issues/4321`)
  })

  contractCase('findSplitIssue resolves to null when no issue carries the marker', async (h) => {
    h.primeIssues([{ number: 7, html_url: `https://tracker.test/${h.repo}/issues/7`, title: 'Other', body: 'unrelated', labels: [], state: 'open' }])
    assert.equal(await h.tracker.findSplitIssue(h.repo, 'horizon-contract-marker', new Date(0).toISOString()), null)
  })

  contractCase('findSplitIssue resolves to the issue that carries the marker', async (h) => {
    const marked = { number: 8, html_url: `https://tracker.test/${h.repo}/issues/8`, title: 'Marked', body: 'x horizon-contract-marker y', labels: [], state: 'open' }
    h.primeIssues([marked])
    const found = await h.tracker.findSplitIssue(h.repo, 'horizon-contract-marker', new Date(0).toISOString())
    assert.equal(found?.number, 8)
    assert.equal(found?.html_url, marked.html_url)
  })

  contractCase('closeIssueWithSummary rejects when the tracker refuses, and the error reaches the caller', async (h) => {
    h.primeCloseFailure()
    await assert.rejects(() => h.tracker.closeIssueWithSummary(h.item), (err) => err instanceof Error && err.message.length > 0)
  })

  contractCase('pollRepo resolves to { changed: <number> }', async (h) => {
    h.primeIssues([])
    const result = await h.tracker.pollRepo(h.repo, quietLog)
    assert.equal(typeof result, 'object')
    assert.equal(typeof result.changed, 'number')
  })

  contractCase('ingestIssue and ingestComment are no-ops for a repo Horizon does not track', (h) => {
    const repo = 'nobody/contract-untracked'
    assert.ok(!h.tracker.ingestIssue({ number: 1, title: 'x', body: '', labels: [], state: 'open' }, repo))
    assert.ok(!h.tracker.ingestComment(repo, 1, { id: 1, body: 'hello', user: { login: 'someone', type: 'User' } }, quietLog))
  })
}
