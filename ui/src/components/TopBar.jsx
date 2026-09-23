import { useState, useSyncExternalStore } from 'react'
import { GridIcon, LockIcon, SlidersIcon } from './icons'
import * as theme from '../theme'

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

// The bot farm holds one project's context at a time — this is a switcher,
// not a filter. Selecting a different project restarts the farm.
function ProjectSwitcher({ projects, activeProjectId, farm, onRequestSwitch }) {
  const [open, setOpen] = useState(false)
  if (!projects || projects.length === 0) return null
  const active = projects.find((p) => p.id === activeProjectId) || projects[0]

  if (farm?.status === 'restarting') {
    return (
      <div className="farm-chip">
        <span className="farm-chip__dot" />
        Bot farm restarting…
      </div>
    )
  }

  return (
    <div className="usermenu">
      <button className="projswitch" onClick={() => setOpen((o) => !o)}>
        <span className="projswitch__dot" />
        {active.name}
        <span className="projswitch__caret">▾</span>
      </button>
      {open && (
        <>
          <div className="usermenu__scrim" onClick={() => setOpen(false)} />
          <div className="usermenu__menu usermenu__menu--left">
            <div className="usermenu__header">Bot farm runs one project at a time</div>
            {projects.map((p) => (
              <button
                key={p.id}
                className="usermenu__item"
                disabled={p.id === active.id}
                onClick={() => {
                  setOpen(false)
                  onRequestSwitch(p)
                }}
              >
                {p.name}
                {p.id === active.id && <span style={{ marginLeft: 'auto', color: 'var(--success-ink)' }}>✓ active</span>}
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
  activeProjectId,
  farm,
  user,
  onLogout,
  onRequestSwitch,
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

      <ProjectSwitcher
        projects={projects}
        activeProjectId={activeProjectId}
        farm={farm}
        onRequestSwitch={onRequestSwitch}
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
