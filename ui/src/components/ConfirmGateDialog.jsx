import { useEffect, useRef } from 'react'

// The explicit ceremony for a plain Approve (HZ-38): with the gate PIN
// already cached in localStorage, clicking Approve used to hit the server
// instantly with zero confirmation. This dialog is the one thing standing
// between the click and the request — it must always name the real decision
// (item + gate), never a generic "Are you sure?".
export default function ConfirmGateDialog({ itemId, gateLabel, onConfirm, onCancel }) {
  const panelRef = useRef(null)

  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        onConfirm()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onConfirm, onCancel])

  return (
    <div className="composer">
      <div className="composer__scrim" onClick={onCancel} />
      <div
        className="composer__panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-gate-title"
        aria-describedby="confirm-gate-sub"
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="composer__title" id="confirm-gate-title">
          Approve this gate?
        </div>
        <div className="composer__sub" id="confirm-gate-sub">
          <strong>{itemId}</strong> · {gateLabel}
        </div>
        <div className="composer__actions">
          <button className="composer__cancel" onClick={onCancel}>
            Cancel
          </button>
          <button className="composer__submit" style={{ background: '#0E6E74' }} onClick={onConfirm}>
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}
