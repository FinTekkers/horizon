// HO-875: what an item's tracker record is. A GitHub item has an issue; an sl
// item keeps `issue` NULL and has a Task (work_item.task_id). An item with
// neither is local or demo and has no tracker to write to. A leaf: it imports
// nothing.
//
// Call sites of the Tracker port's methods (create, comment, close) guard on
// hasTrackerRef. The GitHub-shaped helpers (issue bodies, labels, releases)
// keep guarding on hasGithubIssue, so an sl item never reaches them.

export const hasGithubIssue = (item) => item?.issue != null

export const hasTask = (item) => item?.task_id != null && item.task_id !== ''

export const hasTrackerRef = (item) => hasGithubIssue(item) || hasTask(item)

// The item's tracker record in event text: "issue #12" or "Task 41".
export const trackerRefText = (item) => (hasGithubIssue(item) ? `issue #${item.issue}` : `Task ${item.task_id}`)
