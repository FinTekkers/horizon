import { useState } from 'react'
import { GridIcon, LockIcon, SlidersIcon } from './icons'

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
                {p.id === active.id && <span style={{ marginLeft: 'auto', color: '#0E6E74' }}>✓ active</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function UserMenu({ onOpenAdmin }) {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  return (
    <div className="usermenu">
      <button className="topbar__avatar" onClick={() => setOpen((o) => !o)}>
        AP
      </button>
      {open && (
        <>
          <div className="usermenu__scrim" onClick={close} />
          <div className="usermenu__menu">
            <div className="usermenu__header">
              Signed in as <strong>AP</strong> (demo)
            </div>
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
            <button className="usermenu__item" disabled title="Not implemented yet">
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
  onRequestSwitch,
  onBoard,
  onTracker,
  onOpenApprovals,
  onOpenAdmin,
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
      <UserMenu onOpenAdmin={onOpenAdmin} />
    </div>
  )
}
