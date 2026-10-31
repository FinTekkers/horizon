import { useState } from 'react'
import { ADMIN_GROUPS, ADMIN_SECTIONS, matchSections } from './adminRoutes'

// HZ-564: Admin's left-hand list — the sections in their groups, with
// "Find a setting" narrowing it. The search only filters this list; the open
// section stays shown whatever is typed. `badges` maps a section key to its
// count ({ value, warn }); `extraTerms` adds words from live data, so a
// project or repository name finds Projects. HZ-660: `sections` is the list
// this user may open (visibleSections); a group with none left is not shown.
export default function AdminNav({ section, onSelect, badges = {}, extraTerms, sections: shown = ADMIN_SECTIONS }) {
  const [query, setQuery] = useState('')
  const matches = matchSections(query, extraTerms, shown)
  const groups = ADMIN_GROUPS.map((group) => ({
    group,
    sections: shown.filter((s) => s.group === group && matches.has(s.key)),
  })).filter((g) => g.sections.length > 0)

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
      {groups.map(({ group, sections }) => (
        <div key={group} className="admin-nav__group" role="group" aria-labelledby={`admin-nav-${group}`}>
          <span id={`admin-nav-${group}`} className="admin-nav__group-name">
            {group}
          </span>
          {sections.map((s) => {
            const badge = Object.hasOwn(badges, s.key) ? badges[s.key] : null
            return (
              <button
                key={s.key}
                type="button"
                className={`admin-nav__item${s.key === section ? ' admin-nav__item--on' : ''}`}
                aria-current={s.key === section ? 'page' : undefined}
                onClick={() => onSelect(s.key)}
              >
                <span className="admin-nav__label">{s.label}</span>
                {badge && (
                  <span className={`admin-nav__badge${badge.warn ? ' admin-nav__badge--warn' : ''}`}>{badge.value}</span>
                )}
              </button>
            )
          })}
        </div>
      ))}
    </aside>
  )
}
