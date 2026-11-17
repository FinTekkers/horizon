// HO-872: the shared VCS port contract. Every backend adapter that
// forRepo(repo).vcs can hand out runs this same suite: the GitHub adapter in
// test/vcs-contract-github.test.mjs today, the sl adapter (HO-877) next. It is
// a helper, not a test file. `npm test` globs test/*.test.mjs only, so this
// runs only when an adapter's own test file calls runVcsContract().
//
// What callers rely on (Accept in app.js, the deploy queue, auto-resolve):
//
//   land(item, { sha, approvals, log }) → Promise<{ hash: string | null }>
//       Lands the item's change, pinned to `sha` (the head the pre-merge
//       checks passed). `hash` is the landed commit when the backend names
//       one. It is null when the commit is read some other way: GitHub's is
//       the PR merge commit, which the deploy queue reads with
//       review.getPrMergeSha. app.js calls land only inside the item's premerge
//       claim. Item fields read: repo, pr, id.
//       Rejects with an Error whose message app.js shows as is.
//   getBranchSha(repo, branch)     → Promise<string>, a 40-hex commit sha.
//   isAncestor(repo, base, head)   → Promise<boolean>; rejects when unknown.
//   defaultBranchOf(repo)          → string, from cache only (no call).
//   defaultBranchStale(at, now)    → boolean: whether a read at `at` is due again.
//
// makeHarness() is called once per case and returns:
//   vcs                 the adapter under test
//   repo                a repo the adapter may act on
//   item                an item on `repo` with a change to land: { id, repo, pr, ... }
//   sha / otherSha      two distinct 40-hex commits on `repo`
//   primeBranch(b, sha) branch `b` of `repo` points at `sha`
//   primeAncestor(yes)  isAncestor(repo, sha, otherSha) answers `yes`
//   primeLandRefused()  the next land is refused by the backend
//   landCalls()         how many land requests reached the backend
//   restore()           undoes everything the harness changed
//   violations()        (optional) problems the harness saw; must be [] after every case

import { test } from 'node:test'
import assert from 'node:assert/strict'

// The VCS port: every method forRepo(repo).vcs carries.
export const VCS_METHODS = Object.freeze([
  'validateRepo',
  'getBranchSha',
  'isAncestor',
  'getRepoPermissions',
  'findReleaseByTag',
  'createBatchRelease',
  'createDeployRelease',
  'land',
  'defaultBranchOf',
  'defaultBranchStale',
  'setMainHeadListener',
  'parseRepo',
  'validateToken',
  'verifySignature',
])

const SHA = /^[0-9a-f]{40}$/
const quietLog = { info() {}, warn() {}, error() {}, debug() {} }

export function runVcsContract(name, makeHarness) {
  const contractCase = (title, body) =>
    test(`vcs contract (${name}): ${title}`, async () => {
      const harness = await makeHarness()
      try {
        await body(harness)
        assert.deepEqual(harness.violations?.() ?? [], [], 'the harness saw no live call or wrong credential')
      } finally {
        await harness.restore()
      }
    })

  contractCase('carries exactly the port methods, each a function', ({ vcs }) => {
    assert.deepEqual(Object.keys(vcs).sort(), [...VCS_METHODS].sort())
    for (const method of VCS_METHODS) assert.equal(typeof vcs[method], 'function', method)
  })

  contractCase('land resolves to { hash } — a string commit or null — after one land request', async (h) => {
    const result = await h.vcs.land(h.item, { sha: h.sha, approvals: null, log: quietLog })
    assert.equal(typeof result, 'object')
    assert.ok(result !== null)
    assert.ok(Object.hasOwn(result, 'hash'), 'land result has an own `hash`')
    assert.ok(result.hash === null || (typeof result.hash === 'string' && result.hash.length > 0), `hash: ${result.hash}`)
    assert.equal(h.landCalls(), 1)
  })

  contractCase('land rejects with a non-empty Error message when the backend refuses', async (h) => {
    h.primeLandRefused()
    await assert.rejects(
      () => h.vcs.land(h.item, { sha: h.sha, approvals: null, log: quietLog }),
      (err) => err instanceof Error && err.message.length > 0,
    )
  })

  contractCase('getBranchSha resolves to the branch tip as a 40-hex sha', async (h) => {
    h.primeBranch('main', h.sha)
    const sha = await h.vcs.getBranchSha(h.repo, 'main')
    assert.match(sha, SHA)
    assert.equal(sha, h.sha)
  })

  contractCase('isAncestor resolves to a boolean, true and false as the backend answers', async (h) => {
    h.primeAncestor(true)
    assert.equal(await h.vcs.isAncestor(h.repo, h.sha, h.otherSha), true)
    h.primeAncestor(false)
    assert.equal(await h.vcs.isAncestor(h.repo, h.sha, h.otherSha), false)
  })

  contractCase('defaultBranchOf answers from cache with a non-empty branch name', (h) => {
    const branch = h.vcs.defaultBranchOf(h.repo)
    assert.equal(typeof branch, 'string')
    assert.ok(branch.length > 0)
  })

  contractCase('defaultBranchStale: never read is stale; a read just now is not', (h) => {
    const now = Date.parse('2026-11-16T12:00:00Z')
    assert.equal(h.vcs.defaultBranchStale(null, now), true)
    assert.equal(h.vcs.defaultBranchStale('2026-11-16 12:00:00', now), false)
  })
}
