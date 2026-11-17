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

import {
  closeIssueAsAbandoned,
  closeIssueWithSummary,
  compareScreenshotsMarkdown,
  createBatchRelease,
  createDeployRelease,
  createIssue,
  createPrFromBranch,
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
  ingestComment,
  ingestIssue,
  isAncestor,
  mergePr,
  patchIssueBodyLines,
  pollComments,
  pollOnce,
  pollRepo,
  postIssueComment,
  pruneArtifactRefs,
  pushIssueScope,
  refreshPrMergeable,
  refreshPrScreenshots,
  screenshotsSection,
  setAutopilotOffLabel,
  setPriorityLabel,
  startPolling,
  syncIssueBodyFields,
  validateRepo,
} from '../github.js'

// HO-871, transitional and not part of any adapter group: the land-path git
// lookups spawn.js's "is the shipped code live" check runs, and the request
// headers webhooks.js sends when it registers repo hooks. They let those two
// files stop importing ../github.js; HO-872 moves them onto its own ports and
// removes this line.
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
  }),
  // Pull requests.
  review: Object.freeze({
    createPrFromBranch,
    getPrHead,
    getPrHeadSha,
    getPrFiles,
    getPrMergeSha,
    mergePr,
    refreshPrMergeable,
    refreshPrScreenshots,
  }),
  // The repository itself: branches, ancestry, permissions, releases.
  vcs: Object.freeze({
    validateRepo,
    getBranchSha,
    isAncestor,
    getRepoPermissions,
    findReleaseByTag,
    createBatchRelease,
    createDeployRelease,
  }),
  // Screenshots and other artifacts stored as git refs and blobs.
  artifacts: Object.freeze({
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
