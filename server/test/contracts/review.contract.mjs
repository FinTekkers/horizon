// HO-872: the shared Review port contract. Every backend adapter that
// forRepo(repo).review can hand out runs this same suite: the GitHub adapter
// in test/review-contract-github.test.mjs today, the sl adapter (HO-877)
// next. It is a helper, not a test file. `npm test` globs test/*.test.mjs
// only, so this runs only when an adapter's own test file calls
// runReviewContract().
//
// What callers rely on (Accept's pre-merge check in app.js, the deploy queue,
// auto-resolve, and the caretaker through its injected refreshMergeable):
//
//   getPrHead(item)          → Promise<{ sha, ref, baseRef }>; sha is 40-hex.
//   getPrMergeSha(item)      → Promise<string>, the 40-hex commit the review
//                              merged as. Rejects for a review not merged.
//                              The deploy queue deploys exactly this commit.
//                              It never reads work_item.landed_hash.
//   refreshPrMergeable(itemId, repo, pr) → Promise<1 | 0 | null>
//                              1 merges cleanly, 0 conflicts, null unknown.
//
// makeHarness() is called once per case and returns:
//   review               the adapter under test
//   repo                 a repo the adapter may act on
//   item                 an item on `repo` with a review: { id, repo, pr, ... }
//   primePr(state)       the review reads as `state`:
//                          { merged, mergeSha, headSha, headRef, baseRef, mergeable }
//   restore()            undoes everything the harness changed
//   violations()         (optional) problems the harness saw; must be [] after every case

import { test } from 'node:test'
import assert from 'node:assert/strict'

// The Review port: every method forRepo(repo).review carries.
export const REVIEW_METHODS = Object.freeze([
  'createPrFromBranch',
  'createMockPr',
  'getPrHead',
  'getPrHeadSha',
  'getPrFiles',
  'getPrMergeSha',
  'mergePr',
  'refreshPrMergeable',
  'refreshPrScreenshots',
  'handlePrStateChange',
  'setPrMergedListener',
  'prsForCommit',
])

const SHA = /^[0-9a-f]{40}$/
const A = 'a'.repeat(40)
const M = 'f'.repeat(40)

export function runReviewContract(name, makeHarness) {
  const contractCase = (title, body) =>
    test(`review contract (${name}): ${title}`, async () => {
      const harness = await makeHarness()
      try {
        await body(harness)
        assert.deepEqual(harness.violations?.() ?? [], [], 'the harness saw no live call or wrong credential')
      } finally {
        await harness.restore()
      }
    })

  contractCase('carries exactly the port methods, each a function', ({ review }) => {
    assert.deepEqual(Object.keys(review).sort(), [...REVIEW_METHODS].sort())
    for (const method of REVIEW_METHODS) assert.equal(typeof review[method], 'function', method)
  })

  contractCase('getPrHead resolves to the head sha, its ref and the base branch', async (h) => {
    h.primePr({ merged: false, headSha: A, headRef: 'horizon/ct-1', baseRef: 'main' })
    const head = await h.review.getPrHead(h.item)
    assert.match(head.sha, SHA)
    assert.deepEqual(head, { sha: A, ref: 'horizon/ct-1', baseRef: 'main' })
  })

  contractCase('getPrMergeSha rejects for a review that is not merged', async (h) => {
    h.primePr({ merged: false, headSha: A, baseRef: 'main' })
    await assert.rejects(() => h.review.getPrMergeSha(h.item), (err) => err instanceof Error && err.message.length > 0)
  })

  contractCase('getPrMergeSha resolves to the merge commit of a merged review', async (h) => {
    h.primePr({ merged: true, mergeSha: M, headSha: A, baseRef: 'main' })
    const sha = await h.review.getPrMergeSha(h.item)
    assert.match(sha, SHA)
    assert.equal(sha, M)
  })

  contractCase('refreshPrMergeable resolves to 1, 0 or null as the review reads', async (h) => {
    for (const [mergeable, flag] of [
      [true, 1],
      [false, 0],
      [null, null],
    ]) {
      h.primePr({ merged: false, headSha: A, baseRef: 'main', mergeable })
      assert.equal(await h.review.refreshPrMergeable(h.item.id, h.repo, h.item.pr), flag, `mergeable ${mergeable}`)
    }
  })
}
