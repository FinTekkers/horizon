// HO-875: what an item's tracker record is. A GitHub item has an issue; an sl
// item keeps `issue` NULL and has a Task (work_item.task_id). An item with
// neither is local or demo and has no tracker to write to. Imports only the
// leaf backends/names.js, so any module may use it.
//
// Call sites of the Tracker port's methods (create, comment, close) guard on
// hasTrackerRef. The GitHub-shaped helpers (issue bodies, labels, releases)
// keep guarding on hasGithubIssue, so an sl item never reaches them.
//
// HO-901: a null `issue` means two things — a local demo item (no repo) or an
// sl Task-backed item (a repo on the sl backend). Every server/src check on an
// item's `issue` goes through these predicates instead of a bare null test, so
// a Task-backed item never silently takes a demo item's path. They read only
// the item's own repo, issue and backend (work_item.backend: the repo's
// backend, set on insert and immutable), never the live project_repo row — a
// disconnected sl repo's item stays Task-backed. An object with no `backend`
// (a hand-built test item or board view) reads as the default, GitHub.

import { DEFAULT_BACKEND } from './backends/names.js'

const backendOfItem = (item) => item.backend ?? DEFAULT_BACKEND

// A local demo item: no repo, so no tracker, PR or release.
export const isLocalItem = (item) => item != null && !item.repo

// A GitHub item with its issue: the only kind of item the GitHub issue, label
// and release helpers may touch.
export const hasGithubIssue = (item) =>
  item != null && Boolean(item.repo) && item.issue != null && backendOfItem(item) === DEFAULT_BACKEND

// An item on an sl repo, backed by a Task rather than a GitHub issue.
export const isTaskBackedItem = (item) => item != null && Boolean(item.repo) && backendOfItem(item) === 'sl'

export const hasTask = (item) => item?.task_id != null && item.task_id !== ''

export const hasTrackerRef = (item) => hasGithubIssue(item) || hasTask(item)

// The item's tracker record in event text: "issue #12" or "Task 41".
export const trackerRefText = (item) => (hasGithubIssue(item) ? `issue #${item.issue}` : `Task ${item.task_id}`)

// HO-901: why an sl item's Deploy step fails. There is no sl release path yet,
// so the step ends in a visible, named error instead of a demo item's skip.
export const deployUnsupportedReason = (item) =>
  `deploy_unsupported: ${item.id} is on the sl backend, which has no release path yet`
