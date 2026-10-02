// Per-browser project filter (HZ-208). View state only: it narrows what the
// board, tracker and approvals drawer render, and never calls the server —
// switching projects cannot activate, enable, restart, cancel or pause
// anything. The snapshot already carries every enabled project's items.

export const ALL_PROJECTS = 'all'

const STORAGE_KEY = 'horizon.projectFilter'

export function enabledProjects(projects) {
  return (projects || []).filter((p) => p.enabled)
}

// 'all', or the id of a project that is still enabled. Anything else — an
// unknown id, a disabled project, a value from before a project was deleted —
// falls back to 'all', so a stale filter can never hide every item.
export function validProjectFilter(value, projects) {
  if (value === ALL_PROJECTS) return ALL_PROJECTS
  return enabledProjects(projects).some((p) => p.id === value) ? value : ALL_PROJECTS
}

// The saved choice as written, before validation: 'all' or a project id. The
// app validates it on every render, because the project list arrives over
// SSE after first paint.
export function readStoredProjectFilter() {
  let raw = null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    // private browsing — no saved filter
  }
  if (raw == null || raw === ALL_PROJECTS) return ALL_PROJECTS
  const id = Number(raw)
  return Number.isInteger(id) ? id : ALL_PROJECTS
}

export function writeProjectFilter(value) {
  try {
    localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    // private browsing — the filter just isn't remembered
  }
}

export function filterByProject(items, filter) {
  if (filter === ALL_PROJECTS) return items
  return items.filter((item) => item.project_id === filter)
}
