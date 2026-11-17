import { useEffect, useRef, useState } from 'react'

// HO-851: "Design it anyway" on a design sub-step its verdict skipped, at a
// gate. The owner must give a reason: Submit stays disabled while it is blank,
// and the server refuses a blank one too (400 reason_required). The reason is
// kept as the forced round's brief and override reason. A PIN dialog answers
// the route's 401, as for every send-back.

const ERRORS = {
  reason_required: 'Give a reason for designing it anyway.',
  not_skipped: 'This design was not skipped, so send it back instead.',
  not_at_gate: 'This item is no longer at a gate.',
  stale_step: 'This item moved since the page loaded. Reload the page and try again.',
  pin_needed: 'Enter the gate PIN to design it anyway.',
  human_gate_key_required: 'Enter the gate PIN to design it anyway.',
  network: 'No answer from the server. Try again.',
}

export function DesignAnywayDialog({ itemId, sub, onSubmit, onClose }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inFlight = useRef(false)
  const panelRef = useRef(null)
  const ready = reason.trim() !== ''

  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape' && !inFlight.current) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const submit = (e) => {
    e.preventDefault()
    if (!ready || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    new Promise((resolve) => resolve(onSubmit(itemId, sub.id, reason.trim())))
      .then(() => {
        inFlight.current = false
        onClose()
      })
      .catch((err) => {
        inFlight.current = false
        setBusy(false)
        setError(ERRORS[err?.message] || 'The request did not go through. Try again.')
      })
  }

  return (
    <div className="composer">
      <div className="composer__scrim" onClick={busy ? undefined : onClose} />
      <form
        className="composer__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="design-anyway-title"
        ref={panelRef}
        tabIndex={-1}
        onSubmit={submit}
      >
        <div className="composer__title" id="design-anyway-title">
          Design it anyway
        </div>
        <div className="composer__sub">
          <strong>{itemId}</strong> · “{sub.label}” was skipped: {sub.skip?.reason}. Say why it should run. The reason is kept with
          the round.
        </div>
        <label className="composer__field">
          <span className="composer__field-label">Reason</span>
          <textarea
            className="composer__input"
            aria-label="Reason to design it anyway"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        {error && (
          <div className="composer__hint" role="alert">
            {error}
          </div>
        )}
        <div className="composer__actions">
          <button type="button" className="composer__cancel" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="composer__submit" disabled={!ready || busy} aria-busy={busy || undefined}>
            {busy ? 'Starting…' : 'Design it'}
          </button>
        </div>
      </form>
    </div>
  )
}

// The button on the skipped row, and the dialog it opens.
export default function DesignAnywayButton({ itemId, sub, onSubmit, disabled = false }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="btn-gate-feedback" disabled={disabled} aria-busy={disabled || undefined} onClick={() => setOpen(true)}>
        Design it anyway
      </button>
      {open && <DesignAnywayDialog itemId={itemId} sub={sub} onSubmit={onSubmit} onClose={() => setOpen(false)} />}
    </>
  )
}
