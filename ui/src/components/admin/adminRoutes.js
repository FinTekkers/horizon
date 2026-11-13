// HZ-564: Admin's sections and their deep links. App.jsx's parsePath hands
// everything after `/admin` to parseAdminPath, so `/admin/...` never falls
// through to the item tracker; AdminPage builds each section's path with
// adminPath and pushes it through App's navigate.

// The left-hand list, in the design's order. `keywords` feed "Find a setting".
// HZ-660: `ownerOnly` sections read owner-only routes, so a member never sees
// them — only Account, which reads their own PIN and tokens. HZ-703:
// `memberOnly` sections are a member's own project settings, over the tenant
// API; the owner sets those in Projects and never sees them.
export const ADMIN_SECTIONS = [
  // HZ-764: broken webhooks, flaky tests and failed deploys across the
  // owner's projects, each with its fix. Admin opens here when it has rows.
  {
    key: 'attention',
    ownerOnly: true,
    group: 'Needs attention',
    label: 'Needs attention',
    keywords: ['webhook', 'flaky', 'failed deploy', 'broken', 'fix'],
  },
  // HZ-764: AdminNav lists one entry per project in place of this one, each
  // carrying these keywords, then New project.
  {
    key: 'projects',
    ownerOnly: true,
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
      'isolation',
      'agents',
      'automation',
    ],
  },
  {
    key: 'checks',
    memberOnly: true,
    group: 'Projects',
    label: "Your project's check commands",
    keywords: ['check commands', 'install', 'test', 'e2e', 'repository', 'repo'],
  },
  {
    key: 'deploys',
    ownerOnly: true,
    group: 'Delivery',
    label: 'Deploy targets',
    keywords: ['deploy', 'target', 'script', 'service', 'dry run', 'overrides', 'health', 'release'],
  },
  {
    key: 'flaky',
    ownerOnly: true,
    group: 'Delivery',
    label: 'Flaky tests',
    keywords: ['flaky', 'flake', 'rerun', 'tests'],
  },
  // HO-848: HO-841's Verify outcomes and Execute causes for a Task cohort.
  {
    key: 'verify',
    ownerOnly: true,
    group: 'Delivery',
    label: 'Verify report',
    keywords: ['verify', 'verdict', 'prereq', 'first pass yield', 'proof incomplete', 'execute cause'],
  },
  {
    key: 'github',
    ownerOnly: true,
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

// HZ-660: the section a member lands on in place of an owner-only one (bare
// `/admin` included).
export const MEMBER_ADMIN_SECTION = 'account'

// The sections this user may open, in order.
export function visibleSections(isOwner) {
  return ADMIN_SECTIONS.filter((s) => (isOwner ? !s.memberOnly : !s.ownerOnly))
}

// True when `section` is one a member may not open (an unknown key included).
export function isOwnerOnlySection(section) {
  return !visibleSections(false).some((s) => s.key === section)
}

// HZ-703: true when `section` is one the owner may not open.
export function isMemberOnlySection(section) {
  return ADMIN_SECTIONS.some((s) => s.key === section && s.memberOnly)
}

// HZ-764: a project page's tabs, in order. The first is the default, so its
// URL is the bare project path.
export const PROJECT_TABS = ['repositories', 'automation', 'agents', 'settings']

// Bare `/admin`: no section yet. AdminPage picks one (HZ-764's landing rule);
// a member's goes to Account (HZ-660).
export const ADMIN_HOME = { section: null, project: null, repo: null, tab: null, home: true, unknown: false }

const PROJECT_ID = /^\d+$/

// `rest` is the path after `/admin`, decoded, with no leading or trailing
// slash: '' | 'deploys' | 'attention' | 'projects/new' | 'projects/<id>' |
// 'projects/<id>/<tab>' | 'projects/<id>/repos/<owner>/<name>'. `<id>` is the
// numeric project id. Anything else, the pre-HZ-764
// 'projects/<slug>/<repo>/<tab>' included, is unknown: Admin opens as for bare
// `/admin` and App rewrites the URL to `/admin`.
export function parseAdminPath(rest) {
  const parts = rest ? rest.split('/').filter(Boolean) : []
  if (parts.length === 0) return ADMIN_HOME
  const unknown = { ...ADMIN_HOME, home: false, unknown: true }
  const section = parts[0].toLowerCase()
  if (!SECTION_KEYS.has(section)) return unknown
  const route = { ...ADMIN_HOME, home: false, section }
  if (section !== 'projects') return parts.length === 1 ? route : unknown
  const [, project, ...more] = parts
  if (project === undefined) return route
  if (project.toLowerCase() === 'new') return more.length === 0 ? { ...route, project: 'new' } : unknown
  if (!PROJECT_ID.test(project)) return unknown
  if (more.length === 0) return { ...route, project }
  const tab = more[0].toLowerCase()
  if (more.length === 1 && PROJECT_TABS.includes(tab)) return { ...route, project, tab }
  if (more.length === 3 && tab === 'repos') return { ...route, project, tab: 'repositories', repo: `${more[1]}/${more[2]}` }
  return unknown
}

// The path (no base prefix) for a section, e.g. `/admin/deploys`, or for a
// project page, its tab or one of its repositories. The Repositories tab is the
// bare project path.
export function adminPath({ section, project = null, tab = null, repo = null }) {
  if (!SECTION_KEYS.has(section)) return '/admin'
  if (section !== 'projects' || project == null) return `/admin/${section}`
  const base = `/admin/projects/${encodeURIComponent(project)}`
  if (repo) return `${base}/repos/${String(repo).split('/').map(encodeURIComponent).join('/')}`
  return tab && tab !== PROJECT_TABS[0] ? `${base}/${tab}` : base
}

// The section keys whose label, group or keywords contain the query, case
// insensitive. `extraTerms` adds per-section words from live data. An empty
// query matches every one. `sections` is the list to search: AdminNav passes
// its entries (one per project in place of `projects`).
export function matchSections(query, extraTerms = {}, sections = ADMIN_SECTIONS) {
  const q = query.trim().toLowerCase()
  const all = sections.map((s) => s.key)
  if (!q) return new Set(all)
  return new Set(
    sections.filter((s) => {
      const extra = Object.hasOwn(extraTerms, s.key) ? extraTerms[s.key] : []
      return [s.label, s.group, ...s.keywords, ...extra].some((term) => String(term).toLowerCase().includes(q))
    }).map((s) => s.key),
  )
}
