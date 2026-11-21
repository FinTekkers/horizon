// HO-870: the GitHub backend's adapters, grouped as backends/index.js hands
// them out. Every field is the very function object server/src/github.js
// exports — no wrapper, no re-binding — so a caller that moves onto forRepo()
// (HO-871, HO-872) runs exactly the code it runs today.
//
// HO-871: the tracker group's results are GitHub's own shapes — createIssue
// resolves to GitHub's issue JSON (`number`, `html_url`), and ingestIssue /
// ingestComment take GitHub webhook and poll payloads. They are called only
// from the /api/webhooks/github route and github.js's own polling.
// test/contracts/tracker.contract.mjs writes that result type down.
// getSyncState, pollOnce and startPolling cover every connected repo, not the
// one forRepo() was asked about; callers reach them through forKind('github').
//
// HO-872: the review and vcs groups are the Review and VCS ports that Accept,
// the deploy queue, the caretaker and auto-resolve call. Their contracts are
// test/contracts/review.contract.mjs and test/contracts/vcs.contract.mjs.
// vcs.land is github.js's land, mergePr unchanged, resolving { hash: null }.
// The listeners (setPrMergedListener, setMainHeadListener) and the request
// helpers that take no repo (parseRepo, validateToken, verifySignature) serve
// GitHub's poll and webhook as a whole, so callers reach them through
// forKind('github'), like getSyncState. createMockPr, the issue groups and the
// release calls are still GitHub-shaped; a later item splits them.
//
// HO-873: the artifacts group leads with the Artifact port's six methods, each
// github.js's own one-line wrapper over the existing artifact functions.

import {
  closeIssueAsAbandoned,
  closeIssueWithSummary,
  compareScreenshotsMarkdown,
  createBatchRelease,
  createDeployRelease,
  createIssue,
  createMockPr,
  createPrFromBranch,
  defaultBranchOf,
  defaultBranchStale,
  deleteArtifactRef,
  fetchBlob,
  fetchScreenshotResults,
  fetchScreenshotSnapshot,
  fetchScreenshotsMarkdown,
  findReleaseByTag,
  findSplitIssue,
  getBranchSha,
  getIssueBody,
  getPrFiles,
  getPrHead,
  getPrHeadSha,
  getPrMergeSha,
  getRepoPermissions,
  getSyncState,
  handlePrStateChange,
  ingestComment,
  ingestIssue,
  isAncestor,
  land,
  listArtifacts,
  mergePr,
  parseRepo,
  patchIssueBodyLines,
  pollComments,
  pollOnce,
  pollRepo,
  promoteArtifacts,
  prsForCommit,
  postIssueComment,
  pruneArtifactRefs,
  pruneArtifacts,
  pushIssueScope,
  readArtifactBlob,
  readArtifacts,
  refreshPrMergeable,
  refreshPrScreenshots,
  removeArtifacts,
  screenshotsSection,
  setAutopilotOffLabel,
  setBlobsForTest,
  setMainHeadListener,
  setPrMergedListener,
  setPrStateForTest,
  setPriorityLabel,
  setScreenshotSnapshotForTest,
  startPolling,
  syncIssueBodyFields,
  upsertStatsComment,
  validateRepo,
  validateToken,
  verifySignature,
} from '../github.js'

// HO-871, transitional and not part of any adapter group: the land-path git
// lookups spawn.js's "is the shipped code live" check runs, and the request
// headers webhooks.js sends when it registers repo hooks. They let those two
// files stop importing ../github.js. HO-872 put the four git lookups on the
// review and vcs ports below but left spawn.js and webhooks.js (outside its
// scope) on this line; the item that moves them removes it.
export { defaultBranchOf, getBranchSha, getPrMergeSha, ghHeaders, isAncestor } from '../github.js'

export const githubAdapters = Object.freeze({
  // Issues: the work items' source of truth on GitHub.
  tracker: Object.freeze({
    createIssue,
    postIssueComment,
    closeIssueWithSummary,
    closeIssueAsAbandoned,
    syncIssueBodyFields,
    pushIssueScope,
    getIssueBody,
    patchIssueBodyLines,
    setPriorityLabel,
    setAutopilotOffLabel,
    findSplitIssue,
    pollRepo,
    pollComments,
    // HO-871: inbound sync, for the /api/webhooks/github route and polling.
    ingestIssue,
    ingestComment,
    pollOnce,
    startPolling,
    getSyncState,
    // HZ-921: the item's one Effort & cost stats comment.
    upsertStatsComment,
  }),
  // Pull requests.
  review: Object.freeze({
    createPrFromBranch,
    createMockPr,
    getPrHead,
    getPrHeadSha,
    getPrFiles,
    getPrMergeSha,
    mergePr,
    refreshPrMergeable,
    refreshPrScreenshots,
    // HO-872: a PR merged or closed on GitHub, and app.js's hook for it.
    handlePrStateChange,
    setPrMergedListener,
    // HO-872: the PRs merged into the default branch by a commit (auto-resolve).
    prsForCommit,
  }),
  // The repository itself: branches, ancestry, permissions, releases.
  vcs: Object.freeze({
    validateRepo,
    getBranchSha,
    isAncestor,
    // HO-872: Accept's merge. app.js calls it only inside the premerge claim.
    land,
    // HO-872: the cached default branch, and whether its last read is past
    // GitHub's re-read TTL (the deploy queue releases only a fresh one).
    defaultBranchOf,
    defaultBranchStale,
    // HO-872: auto-resolve's "main moved" hook on the poll.
    setMainHeadListener,
    // HO-872: repo, token and webhook-signature checks that take no repo.
    parseRepo,
    validateToken,
    verifySignature,
    getRepoPermissions,
    findReleaseByTag,
    createBatchRelease,
    createDeployRelease,
  }),
  // Screenshots and other artifacts stored as git refs and blobs.
  // HO-873: the first six are the Artifact port (backends/artifact.js,
  // test/contracts/artifact.contract.mjs); the rest are GitHub-shaped helpers
  // app.js and github.js still call.
  artifacts: Object.freeze({
    readArtifacts,
    readArtifactBlob,
    listArtifacts,
    removeArtifacts,
    pruneArtifacts,
    promoteArtifacts,
    fetchScreenshotsMarkdown,
    fetchScreenshotResults,
    compareScreenshotsMarkdown,
    fetchScreenshotSnapshot,
    fetchBlob,
    screenshotsSection,
    deleteArtifactRef,
    pruneArtifactRefs,
  }),
})

// HO-872: the e2e-only answers app.js's /api/test/* routes set while there is
// no GitHub token. Not an adapter group: no backend but GitHub has them.
export const githubTestHooks = Object.freeze({ setPrStateForTest, setScreenshotSnapshotForTest, setBlobsForTest })
