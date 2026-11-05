import { useState } from 'react'
import { ADMIN_GROUPS, ADMIN_SECTIONS, adminPath, matchSections } from './adminRoutes'

// HZ-764: the list's entries. `projects` becomes one entry per project, then
// New project; each project entry carries the Projects keywords plus its own
// repository names, so "Find a setting" still finds them. Every other section
// is one entry, as before.
export function navEntries(sections, projects = []) {
  return sections.flatMap((s) => {
    if (s.key !== 'projects') return [{ ...s, path: adminPath({ section: s.key }) }]
    return [
      ...projects.map((p) => ({
        key: `project:${p.id}`,
        group: s.group,
        label: p.name,
        keywords: [...s.keywords, ...p.repos.map((r) => r.repo)],
        path: adminPath({ section: 'projects', project: p.id }),
      })),
      {
        key: 'project:new',
        group: s.group,
        label: 'New project',
        keywords: ['new project', 'create project'],
        path: adminPath({ section: 'projects', project: 'new' }),
      },
    ]
  })
}

// HZ-564: Admin's left-hand list — the entries in their groups, with
// "Find a setting" narrowing it. The search only filters this list; the open
// page stays shown whatever is typed. `active` is the open entry's key;
// `badges` maps an entry key to its count ({ value, warn }). HZ-660: `sections`
// is the list this user may open (visibleSections); a group with none left is
// not shown. `onSelect` gets the entry's path.
export default function AdminNav({ active, onSelect, badges = {}, sections = ADMIN_SECTIONS, projects = [] }) {
  const [query, setQuery] = useState('')
  const entries = navEntries(sections, projects)
  const matches = matchSections(query, {}, entries)
  const groups = ADMIN_GROUPS.map((group) => ({
    group,
    entries: entries.filter((e) => e.group === group && matches.has(e.key)),
  })).filter((g) => g.entries.length > 0)

  return (
    <aside className="admin-nav" aria-label="Admin sections">
      <div className="admin-nav__head">
        <h1 className="admin__title">Admin</h1>
        <label className="admin-nav__search">
          Find a setting
          <input
            type="search"
            className="admin-nav__search-input"
            placeholder="e.g. webhook, PIN, ui-service"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      {groups.length === 0 && (
        <p className="admin-nav__empty" role="status">
          No setting matches
        </p>
      )}
      {groups.map(({ group, entries: shown }) => {
        const groupId = `admin-nav-${group.replace(/\s+/g, '-')}`
        return (
          <div key={group} className="admin-nav__group" role="group" aria-labelledby={groupId}>
            <span id={groupId} className="admin-nav__group-name">
              {group}
            </span>
            {shown.map((e) => {
              const badge = Object.hasOwn(badges, e.key) ? badges[e.key] : null
              return (
                <button
                  key={e.key}
                  type="button"
                  className={`admin-nav__item${e.key === active ? ' admin-nav__item--on' : ''}`}
                  aria-current={e.key === active ? 'page' : undefined}
                  onClick={() => onSelect(e.path)}
                >
                  <span className="admin-nav__label">{e.label}</span>
                  {badge && (
                    <span className={`admin-nav__badge${badge.warn ? ' admin-nav__badge--warn' : ''}`}>{badge.value}</span>
                  )}
                </button>
              )
            })}
          </div>
        )
      })}
    </aside>
  )
}
