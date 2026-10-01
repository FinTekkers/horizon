import { ColumnsIcon, ListIcon, LockIcon } from './icons'

// HZ-224: on a phone the top bar's Board/Tracker tabs and Pending approvals
// button move here, within thumb reach. App mounts this only below the
// MOBILE_QUERY breakpoint and passes it the same props as TopBar, so the
// count is the same number the desktop button shows — never a second fetch.
export default function BottomNav({ view, pendingCount, onBoard, onTracker, onOpenApprovals }) {
  const hot = pendingCount > 0
  const tab = (name) => (view === name ? { 'aria-current': 'page' } : {})
  return (
    <nav className="bottomnav" aria-label="Primary">
      <button type="button" className="bottomnav__tab" onClick={onBoard} {...tab('board')}>
        <ColumnsIcon />
        <span className="bottomnav__label">Board</span>
      </button>
      <button type="button" className="bottomnav__tab" onClick={onTracker} {...tab('tracker')}>
        <ListIcon />
        <span className="bottomnav__label">Tracker</span>
      </button>
      {/* Opens the drawer over the current page, so it is never the current page itself. */}
      <button
        type="button"
        className="bottomnav__tab"
        onClick={onOpenApprovals}
        aria-label={`Approvals, ${pendingCount} pending`}
      >
        <span className="bottomnav__icon">
          <LockIcon size={22} strokeWidth={2} />
          <span className={`pending-btn__badge${hot ? ' pending-btn__badge--hot' : ''}`}>{pendingCount}</span>
        </span>
        <span className="bottomnav__label">Approvals</span>
      </button>
    </nav>
  )
}
