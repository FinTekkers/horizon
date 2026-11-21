// HO-875: Tracker port cases that test/contracts/tracker.contract.mjs (HO-871)
// does not cover — a comment, a successful close with its summary, an
// abandon, and the comment poll. Run against BOTH adapters, the same way:
// test/tracker-contract-port-github.test.mjs and test/tracker-contract-sl.test.mjs
// call runTrackerPortContract(). A helper, not a test file (`npm test` globs
// test/*.test.mjs only). HO-871's contract file is not edited.
//
// makeHarness() is called once per case and returns:
//   tracker      the adapter under test
//   repo         the repo the adapter acts on
//   item         an item on `repo` with a tracker record (issue or Task)
//   comments()   the comment bodies the tracker holds for `item`, in order
//                (HZ-921: as edited, where the tracker can edit one)
//   closes()     the closes the tracker received for `item`: [{ summary, reason }]
//                with reason 'completed' or 'not_planned'
//   restore()    undoes everything the harness changed
//   violations() problems the harness saw; must be [] after every case

import { test } from 'node:test'
import assert from 'node:assert/strict'

const quietLog = { info() {}, warn() {}, error() {}, debug() {} }

export function runTrackerPortContract(name, makeHarness) {
  const portCase = (title, body) =>
    test(`tracker port (${name}): ${title}`, async () => {
      const harness = await makeHarness()
      try {
        await body(harness)
        assert.deepEqual(harness.violations(), [], 'the harness saw no stray call or wrong credential')
      } finally {
        await harness.restore()
      }
    })

  portCase('postIssueComment delivers the body to the item’s tracker record', async (h) => {
    await h.tracker.postIssueComment(h.item, 'A port comment. · posted by Horizon_')
    assert.deepEqual(h.comments(), ['A port comment. · posted by Horizon_'])
  })

  portCase('closeIssueWithSummary closes the record as completed, with a non-empty summary naming the metric', async (h) => {
    await h.tracker.closeIssueWithSummary(h.item)
    const closes = h.closes()
    assert.equal(closes.length, 1)
    assert.equal(closes[0].reason, 'completed')
    assert.ok(closes[0].summary.trim().length > 0, 'the summary is not empty')
    assert.ok(closes[0].summary.includes(h.item.metric), 'the summary names the success metric')
  })

  portCase('closeIssueAsAbandoned closes the record as not planned, with the reason', async (h) => {
    await h.tracker.closeIssueAsAbandoned(h.item, 'Superseded by another item.')
    const closes = h.closes()
    assert.equal(closes.length, 1)
    assert.equal(closes[0].reason, 'not_planned')
    assert.ok(closes[0].summary.includes('Superseded by another item.'))
  })

  // HZ-921: at most one stats comment per item, however often it is upserted.
  portCase('upsertStatsComment posts the stats comment once; a second call never posts another', async (h) => {
    const body = (cost) => `**Effort & cost:** Cost ${cost}\n\n<!-- horizon-stats v1 -->\n\`\`\`json\n{}\n\`\`\`\n\n_posted by Horizon_`
    assert.equal(await h.tracker.upsertStatsComment(h.item, body('$1.00')), 'posted')
    assert.equal(await h.tracker.upsertStatsComment(h.item, body('$1.00')), 'unchanged')
    assert.ok(['updated', 'kept'].includes(await h.tracker.upsertStatsComment(h.item, body('$2.00'))))
    const stats = h.comments().filter((c) => c.includes('<!-- horizon-stats v1 -->'))
    assert.equal(stats.length, 1, 'exactly one stats comment')
  })

  portCase('pollComments resolves to { changed: <number> }', async (h) => {
    const result = await h.tracker.pollComments(h.repo, quietLog)
    assert.equal(typeof result, 'object')
    assert.equal(typeof result.changed, 'number')
  })
}
