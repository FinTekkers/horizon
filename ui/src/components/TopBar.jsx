import { useId, useState, useSyncExternalStore } from 'react'
import { GridIcon, LockIcon, SlidersIcon } from './icons'
import * as theme from '../theme'
import { LegalLinks } from './LegalPage'
import { ALL_PROJECTS, enabledProjects, projectFilterLabel, repoChipLabel } from '../projectFilter'

// A switch, not a menu item: toggling it shouldn't dismiss the menu the way
// every other usermenu__item does, since a user very plausibly wants to
// flip it back and forth once or twice to compare themes before moving on.
function ThemeToggle() {
  const current = useSyncExternalStore(theme.subscribe, theme.getTheme)
  const isDark = current === 'dark'
  return (
    <div className="usermenu__item usermenu__item--toggle">
      <span className="usermenu__item-label">Dark mode</span>
      <button
        type="button"
        role="switch"
        aria-checked={isDark}
        aria-label="Dark mode"
        className="theme-switch"
        onClick={() => theme.toggleTheme()}
      >
        <span className="theme-switch__thumb" />
      </button>
    </div>
  )
}

// HZ-208: a view filter, not a switcher. It only narrows what the board,
// tracker and approvals show — choosing a project calls onChange and nothing
// else, so it can never touch the farm or any item. Disabled projects are not
// offered; Admin is the only place they appear.
// HZ-317: a project with two or more repos also gets one toggle chip per repo.
// `repos` is the selected allow-list, or null for all; the chips report a
// new one through onReposChange and, like ThemeToggle, keep the menu open.
function ProjectFilter({ projects, value, onChange, repos, onReposChange }) {
  const [open, setOpen] = useState(false)
  const chipsTitleId = useId()
  const options = enabledProjects(projects)
  if (options.length === 0) return null
  const current = options.find((p) => p.id === value)
  const label = projectFilterLabel(current, repos)
  const choose = (next) => {
    setOpen(false)
    onChange(next)
  }
  const projectRepos = current?.repos || []
  const isOn = (repo) => !repos || repos.includes(repo)
  const onCount = projectRepos.filter((r) => isOn(r.repo)).length
  const toggle = (repo) => {
    // The last selected chip can't be turned off: the filter never hides every repo.
    if (isOn(repo) && onCount === 1) return
    const next = projectRepos.map((r) => r.repo).filter((r) => (r === repo ? !isOn(r) : isOn(r)))
    onReposChange(next.length === projectRepos.length ? null : next)
  }

  return (
    <div className="usermenu">
      <button
        type="button"
        className="projswitch"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Project filter: ${label}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="projswitch__dot" aria-hidden="true" />
        {/* Visually hidden on a phone (HZ-224); the aria-label stays the name. */}
        <span className="projswitch__label" title={current ? label : undefined}>
          {label}
        </span>
        <span className="projswitch__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <>
          <div className="usermenu__scrim" onClick={() => setOpen(false)} />
          <div className="usermenu__menu usermenu__menu--left">
            <div role="menu" aria-label="Show items from">
              <div className="usermenu__header">Show items from</div>
              {[{ id: ALL_PROJECTS, name: 'All projects' }, ...options].map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={p.id === value}
                  className="usermenu__item"
                  onClick={() => choose(p.id)}
                >
                  {p.name}
                  {p.id === value && <span style={{ marginLeft: 'auto', color: 'var(--success-ink)' }}>✓</span>}
                </button>
              ))}
            </div>
            {projectRepos.length >= 2 && (
              <div className="projchips__section">
                <div className="projchips__head">
                  <span id={chipsTitleId}>Repos in {current.name}</span>
                  <button type="button" className="projchips__all" onClick={() => onReposChange(null)}>
                    Select all
                  </button>
                </div>
                <div role="group" aria-labelledby={chipsTitleId} className="projchips">
                  {projectRepos.map((r) => {
                    const on = isOn(r.repo)
                    const locked = on && onCount === 1
                    return (
                      <button
                        key={r.repo}
                        type="button"
                        className="projchip"
                        aria-pressed={on}
                        aria-disabled={locked || undefined}
                        title={locked ? 'At least one repo stays selected' : r.repo}
                        onClick={() => toggle(r.repo)}
                      >
                        {repoChipLabel(r)}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function UserMenu({ user, onLogout, onOpenAdmin, onOpenDefinitions }) {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  return (
    <div className="usermenu">
      <button className="topbar__avatar" onClick={() => setOpen((o) => !o)}>
        {user.initials}
      </button>
      {open && (
        <>
          <div className="usermenu__scrim" onClick={close} />
          <div className="usermenu__menu">
            <div className="usermenu__header">
              Signed in as <strong>{user.name}</strong>
            </div>
            <button
              className="usermenu__item"
              onClick={() => {
                close()
                onOpenDefinitions()
              }}
            >
              <GridIcon />
              Agent definitions
            </button>
            <button
              className="usermenu__item"
              onClick={() => {
                close()
                onOpenAdmin()
              }}
            >
              <SlidersIcon />
              Admin
            </button>
            <ThemeToggle />
            <LegalLinks className="legal-links usermenu__legal" />
            <button
              className="usermenu__item"
              onClick={() => {
                close()
                onLogout()
              }}
            >
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export default function TopBar({
  view,
  pendingCount,
  projects,
  projectFilter,
  onProjectFilterChange,
  repoFilter = null,
  onRepoFilterChange = () => {},
  user,
  onLogout,
  onBoard,
  onTracker,
  onOpenApprovals,
  onOpenAdmin,
  onOpenDefinitions,
}) {
  const hot = pendingCount > 0
  return (
    <div className="topbar">
      <div className="topbar__brand">
        <div className="topbar__logo">
          <GridIcon />
        </div>
        <div>
          <div className="topbar__title">HORIZON</div>
          <div className="topbar__subtitle">Delivery Lifecycle</div>
        </div>
      </div>

      <div className="seg-tabs">
        <button className={`seg-tab${view === 'board' ? ' seg-tab--on' : ''}`} onClick={onBoard}>
          Board
        </button>
        <button className={`seg-tab${view === 'tracker' ? ' seg-tab--on' : ''}`} onClick={onTracker}>
          Tracker
        </button>
      </div>

      <ProjectFilter
        projects={projects}
        value={projectFilter}
        onChange={onProjectFilterChange}
        repos={repoFilter}
        onReposChange={onRepoFilterChange}
      />

      <div className="topbar__spacer" />

      <button className={`pending-btn${hot ? ' pending-btn--hot' : ''}`} onClick={onOpenApprovals}>
        <LockIcon />
        Pending approvals
        <span className={`pending-btn__badge${hot ? ' pending-btn__badge--hot' : ''}`}>{pendingCount}</span>
      </button>
      <UserMenu user={user} onLogout={onLogout} onOpenAdmin={onOpenAdmin} onOpenDefinitions={onOpenDefinitions} />
    </div>
  )
}
