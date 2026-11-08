import { useEffect, useRef, useState } from 'react'
import { approveTarget, menuActions } from '../domain/stepActions'

// HZ-711: the same actions on the item page, a board card and the Approvals
// drawer — Approve, and under ⋯ Return to…, Retry and Abandon — each only
// when the item's snapshot offers it (domain/stepActions). Every click stops
// here, so a board card's own click (open the item) never fires with it.
// Approve goes to App's approve path (confirm, then the PIN dialog); Return
// to… and Retry open the Move dialog; Abandon its own dialog. `approveDisabled`
// while a gate action runs (HZ-216); `approveHidden` while a deploy holds the
// merge (HZ-360), as the gate card hides it.
export default function StepActionMenu({ item, onApprove, onMove, onAbandon, approveDisabled = false, approveHidden = false, className = '' }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const toggleRef = useRef(null)
  const menuRef = useRef(null)
  const actions = menuActions(item)
  const approve = approveHidden ? null : actions.find((a) => a.id === 'approve')
  const more = actions.filter((a) => a.id !== 'approve')

  useEffect(() => {
    if (!open) return undefined
    menuRef.current?.querySelector('[role="menuitem"]')?.focus()
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  if (!approve && more.length === 0) return null

  const close = () => {
    setOpen(false)
    toggleRef.current?.focus()
  }
  const choose = (action) => {
    setOpen(false)
    if (action.id === 'return') onMove(item.id, 'return', null)
    else if (action.id === 'retry') onMove(item.id, 'retry', action.key)
    else if (action.id === 'abandon') onAbandon(item.id)
  }
  // Arrow keys move between the menu's items; Esc closes it.
  const onMenuKeyDown = (e) => {
    const entries = [...(menuRef.current?.querySelectorAll('[role="menuitem"]') ?? [])]
    const at = entries.indexOf(document.activeElement)
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: entries.length - 1 }[e.key]
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (next !== undefined && entries.length) {
      e.preventDefault()
      entries[(next + entries.length) % entries.length].focus()
    }
  }

  const menuId = `step-menu-${item.id}`
  return (
    // Not a control itself: it only keeps its buttons' clicks off the card.
    <div className={`step-menu ${className}`.trim()} ref={rootRef} onClick={(e) => e.stopPropagation()}>
      {approve && (
        <button
          type="button"
          className="btn-approve"
          disabled={approveDisabled}
          aria-busy={approveDisabled || undefined}
          onClick={() => onApprove(item.id, approveTarget(item).label)}
        >
          {approve.label}
        </button>
      )}
      {more.length > 0 && (
        <>
          <button
            type="button"
            ref={toggleRef}
            className="step-menu__toggle"
            aria-label={`More actions for ${item.id}`}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            onClick={() => setOpen((v) => !v)}
          >
            ⋯
          </button>
          {open && (
            <div className="step-menu__list" role="menu" id={menuId} aria-label={`Actions for ${item.id}`} ref={menuRef} onKeyDown={onMenuKeyDown}>
              {more.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={`step-menu__item${action.id === 'abandon' ? ' step-menu__item--danger' : ''}`}
                  onClick={() => choose(action)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
