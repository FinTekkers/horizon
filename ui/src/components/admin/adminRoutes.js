// HZ-564: Admin's sections and their deep links. App.jsx's parsePath hands
// everything after `/admin` to parseAdminPath, so `/admin/...` never falls
// through to the item tracker; AdminPage builds each section's path with
// adminPath and pushes it through App's navigate.

// The left-hand list, in the design's order. `keywords` feed "Find a setting".
export const ADMIN_SECTIONS = [
  {
    key: 'projects',
    group: 'Projects',
    label: 'Projects and repositories',
    keywords: [
      'project',
      'repository',
      'repo',
      'webhook',
      'check commands',
      'test login',
      'env file',
      'autopilot',
      'enabled',
      'step providers',
      'runs on',
      'definitions',
      'no checks',
      'no deploy',
      'prefix',
      'default branch',
      'connect',
    ],
  },
  {
    key: 'deploys',
    group: 'Delivery',
    label: 'Deploy targets',
    keywords: ['deploy', 'target', 'script', 'service', 'dry run', 'overrides', 'health', 'release'],
  },
  {
    key: 'flaky',
    group: 'Delivery',
    label: 'Flaky tests',
    keywords: ['flaky', 'flake', 'rerun', 'tests'],
  },
  {
    key: 'github',
    group: 'Access',
    label: 'GitHub access',
    keywords: ['github', 'access token', 'personal access token', 'sync'],
  },
  {
    key: 'account',
    group: 'Access',
    label: 'Your PIN and API tokens',
    keywords: ['gate pin', 'pin', 'security', 'api tokens', 'bearer', 'revoke'],
  },
]

export const ADMIN_GROUPS = [...new Set(ADMIN_SECTIONS.map((s) => s.group))]

const SECTION_KEYS = new Set(ADMIN_SECTIONS.map((s) => s.key))

export const ADMIN_HOME = { section: 'projects', project: null, repo: null, tab: null, unknown: false }

// `rest` is the path after `/admin`, decoded, with no leading or trailing
// slash: '' | 'deploys' | 'projects/<project>/<repo>/<tab>'. Projects takes
// up to three more segments, kept for the per-repository pages to come; until
// then they show Projects with the URL left as it is. Anything else is
// unknown, shows Projects, and App rewrites its URL to `/admin`.
export function parseAdminPath(rest) {
  const parts = rest ? rest.split('/').filter(Boolean) : []
  if (parts.length === 0) return ADMIN_HOME
  const section = parts[0].toLowerCase()
  if (!SECTION_KEYS.has(section)) return { ...ADMIN_HOME, unknown: true }
  if (section === 'projects' && parts.length <= 4) {
    const [, project = null, repo = null, tab = null] = parts
    return { section, project, repo, tab: tab && tab.toLowerCase(), unknown: false }
  }
  if (parts.length > 1) return { ...ADMIN_HOME, unknown: true }
  return { ...ADMIN_HOME, section }
}

// The path (no base prefix) for a section, e.g. `/admin/deploys`.
export function adminPath({ section }) {
  return SECTION_KEYS.has(section) ? `/admin/${section}` : '/admin'
}

// The section keys whose label, group or keywords contain the query, case
// insensitive. `extraTerms` adds per-section words from live data (project
// and repository names under `projects`). An empty query matches every one.
export function matchSections(query, extraTerms = {}) {
  const q = query.trim().toLowerCase()
  const all = ADMIN_SECTIONS.map((s) => s.key)
  if (!q) return new Set(all)
  return new Set(
    ADMIN_SECTIONS.filter((s) => {
      const extra = Object.hasOwn(extraTerms, s.key) ? extraTerms[s.key] : []
      return [s.label, s.group, ...s.keywords, ...extra].some((term) => String(term).toLowerCase().includes(q))
    }).map((s) => s.key),
  )
}
