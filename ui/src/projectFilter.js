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

// The one function every view narrows through. `repos` (HZ-317) is the
// project's repo allow-list, or null for all repos; when narrowed, an item
// with no repo is hidden, since only items whose repo is selected show.
export function filterByProject(items, filter, repos = null) {
  if (filter === ALL_PROJECTS) return items
  return items.filter((item) => item.project_id === filter && (!repos || repos.includes(item.repo)))
}

// ---- HZ-317: narrow a project to some of its repos ----
// Saved per project under its own key, so horizon.projectFilter keeps its
// plain value and a browser with only that key sees every repo. The value is
// JSON: { "<projectId>": ["Org/repo", ...] }; no entry means all repos.

const REPO_STORAGE_KEY = 'horizon.projectRepos'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// The project's repo allow-list, or null for all repos. Like
// validProjectFilter, anything stale falls back to all: no project, fewer
// than two repos, a non-array or empty list, a repo the project no longer
// has, or a list that covers every repo.
export function validRepoFilter(saved, project) {
  const repos = (project?.repos || []).map((r) => r.repo)
  if (repos.length < 2 || !Array.isArray(saved) || saved.length === 0) return null
  if (!saved.every((repo) => repos.includes(repo))) return null
  const selected = repos.filter((repo) => saved.includes(repo))
  return selected.length === repos.length ? null : selected
}

export function readStoredRepoFilters() {
  try {
    const parsed = JSON.parse(localStorage.getItem(REPO_STORAGE_KEY))
    return isPlainObject(parsed) ? parsed : {}
  } catch {
    // bad JSON or private browsing — every project shows all its repos
    return {}
  }
}

export function writeRepoFilters(map) {
  try {
    localStorage.setItem(REPO_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // private browsing — the choice just isn't remembered
  }
}

// The saved list for one project, read as an own property so an id can never
// pick up something inherited from Object.prototype.
export function storedReposFor(map, projectId) {
  return Object.prototype.hasOwnProperty.call(map, projectId) ? map[projectId] : undefined
}

// The text on the "Show items from" button (and in its aria-label).
export function projectFilterLabel(project, repos) {
  if (!project) return 'All projects'
  if (!repos) return project.name
  if (repos.length <= 3) {
    const prefixes = project.repos.filter((r) => repos.includes(r.repo)).map((r) => r.prefix || repoName(r.repo))
    return `${project.name} · ${prefixes.join(', ')}`
  }
  return `${project.name} · ${repos.length} of ${project.repos.length} repos`
}

function repoName(repo) {
  return repo.split('/').pop()
}

export function repoChipLabel({ repo, prefix }) {
  return prefix ? `${prefix} · ${repoName(repo)}` : repoName(repo)
}
