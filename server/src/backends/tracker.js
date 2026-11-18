// HO-875: the Tracker port's methods — the part of forRepo(repo).tracker every
// backend implements. Items are created, commented on, closed, deduped,
// polled and ingested through these twelve; the result types are written down
// in test/contracts/tracker.contract.mjs.
//
// The tracker group's other six methods (syncIssueBodyFields, pushIssueScope,
// getIssueBody, patchIssueBodyLines, setPriorityLabel, setAutopilotOffLabel)
// are GitHub-shaped helpers: issue bodies and labels. Their call sites run
// only for an item with a GitHub issue, so an sl item never reaches them, and
// the sl adapter keeps them as backend_not_implemented placeholders.
//
// A leaf module: it imports nothing, so it can hold no client or backend type.

export const TRACKER_PORT_METHODS = Object.freeze([
  'createIssue',
  'postIssueComment',
  'closeIssueWithSummary',
  'closeIssueAsAbandoned',
  'findSplitIssue',
  'pollRepo',
  'pollComments',
  'ingestIssue',
  'ingestComment',
  'pollOnce',
  'startPolling',
  'getSyncState',
])
