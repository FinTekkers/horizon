import { useState, useSyncExternalStore } from 'react'
import { GridIcon, LockIcon, SlidersIcon } from './icons'
import * as theme from '../theme'
import { LegalLinks } from './LegalPage'
import { ALL_PROJECTS, enabledProjects } from '../projectFilter'

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
function ProjectFilter({ projects, value, onChange }) {
  const [open, setOpen] = useState(false)
  const options = enabledProjects(projects)
  if (options.length === 0) return null
  const current = options.find((p) => p.id === value)
  const choose = (next) => {
    setOpen(false)
    onChange(next)
  }

  return (
    <div className="usermenu">
      <button
        type="button"
        className="projswitch"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Project filter: ${current ? current.name : 'All projects'}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="projswitch__dot" aria-hidden="true" />
        {/* Visually hidden on a phone (HZ-224); the aria-label stays the name. */}
        <span className="projswitch__label" title={current ? current.name : undefined}>
          {current ? current.name : 'All projects'}
        </span>
        <span className="projswitch__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <>
          <div className="usermenu__scrim" onClick={() => setOpen(false)} />
          <div className="usermenu__menu usermenu__menu--left" role="menu">
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

      <ProjectFilter projects={projects} value={projectFilter} onChange={onProjectFilterChange} />

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
