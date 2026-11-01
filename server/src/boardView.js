// HZ-656: a non-owner's board — the owner's board filtered to the projects the
// user is a member of. Pure — no I/O; app.js's snapshot() and flushBoard() are
// the callers. The owner's board is built once per change and each member's
// view is cut from it here, so filtering never re-reads the store.
//
// Fails closed. The view is built from allowlists and never spreads the board,
// so a key or field added to snapshot() or listProjects() later stays out of a
// member's view until it is named here. `farm`, `sync` and `deployBlock` are
// farm-wide and owner-only; a repo's check commands, marks, default branch and
// test-env file, and a project's isolation fields, are Admin's.
//
// `durationEstimates` is kept: it is farm-wide step medians (store.js), with no
// item or project id in it.
//
// An item can name other items — who filed it, what it filed, its blockers and
// dependents. A member's copy keeps only the ones in their own view, so an item
// in another project is never named, not even by id or title.
//
// Nothing here mutates `board`: the result holds new arrays, new project
// objects and new item objects.

import { planProgress } from './planProgress.js'

const PROJECT_FIELDS = ['id', 'name', 'enabled', 'unlinked', 'autopilot', 'autopilotEvents', 'definitionsEnabled', 'providerDefaults']
const REPO_FIELDS = ['repo', 'prefix']

function pick(source, keys) {
  const out = {}
  for (const key of keys) if (Object.hasOwn(source, key)) out[key] = source[key]
  return out
}

// A member's copy of one listProjects() row. HZ-659: GET /api/projects uses it
// too, so a member's project list and board agree field for field.
export function memberProject(project) {
  return { ...pick(project, PROJECT_FIELDS), repos: project.repos.map((repo) => pick(repo, REPO_FIELDS)) }
}

// A copy of `item` whose links to other items name only `visible` ids.
function memberItem(item, visible) {
  const seen = (ref) => visible.has(ref.id)
  const copy = { ...item }
  if (item.spawnedBy) copy.spawnedBy = seen(item.spawnedBy) ? item.spawnedBy : null
  for (const key of ['spawned', 'blockedBy', 'dependents']) {
    if (Array.isArray(item[key])) copy[key] = item[key].filter(seen)
  }
  if (Array.isArray(item.ruleBlock?.waitingOn)) copy.ruleBlock = { ...item.ruleBlock, waitingOn: item.ruleBlock.waitingOn.filter(seen) }
  return copy
}

// `board`: a snapshot() built with no viewer. `viewer`: { projectIds }.
// `activeProjectId`: the member's own user.active_project_id (HZ-661), never
// the board's global one — kept only while they are still a member of it, so
// a stale id after a removal is null, not another project.
// `itemVisible`: store.viewerItemFilter(viewer), the same predicate
// listItems({ viewer }) applies, so a member's first frame and every later
// delta agree on which items they see. `parents`: store.spawnParents(),
// needed only when the board carries planProgress.
export function viewSnapshot(board, viewer, { itemVisible, parents = null, activeProjectId = null }) {
  const shown = board.items.filter(itemVisible)
  const visible = new Set(shown.map((item) => item.id))
  const items = shown.map((item) => memberItem(item, visible))
  const projects = board.projects
    .filter((project) => !project.unlinked && viewer.projectIds.has(project.id))
    .map(memberProject)
  const active = activeProjectId != null && viewer.projectIds.has(activeProjectId)
  const view = {
    // board.repoUrl is the global active project's repo: shown only when that
    // is the member's own active project too.
    repoUrl: active && activeProjectId === board.activeProjectId ? board.repoUrl : null,
    projects,
    activeProjectId: active ? activeProjectId : null,
    items,
  }
  if (Object.hasOwn(board, 'durationEstimates')) view.durationEstimates = board.durationEstimates
  if (Object.hasOwn(board, 'planProgress')) {
    // Only Plans the member can see: a parent in another project would name
    // its title.
    view.planProgress = planProgress(items, new Map([...parents].filter(([id]) => visible.has(id))))
  }
  return view
}
