// HO-870: the GitHub backend's adapters, grouped as backends/index.js hands
// them out. Every field is the very function object server/src/github.js
// exports — no wrapper, no re-binding — so a caller that moves onto forRepo()
// (HO-871, HO-872) runs exactly the code it runs today.

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
  isAncestor,
  mergePr,
  patchIssueBodyLines,
  pollComments,
  pollRepo,
  postIssueComment,
  pruneArtifactRefs,
  pushIssueScope,
  refreshPrMergeable,
  refreshPrScreenshots,
  screenshotsSection,
  setAutopilotOffLabel,
  setPriorityLabel,
  syncIssueBodyFields,
  validateRepo,
} from '../github.js'

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
