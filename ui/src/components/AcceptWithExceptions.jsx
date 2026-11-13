import { useEffect, useRef, useState } from 'react'

// HO-844: Accept with exceptions at a Task's Review & close. The item's
// `acceptWithExceptions` ({ openLines, linesHash }, from the server) is the
// whole offer: one required reason per open metric line. The request carries
// only { lineId, reason } pairs and the hash of the lines shown; the server
// re-reads the verdict and the open lines, and a PIN dialog answers its 401.

const ERRORS = {
  open_lines_changed: 'The open metric lines changed since this page loaded. Reload the page and try again.',
  stale_step: 'This item moved since the page loaded. Reload the page and try again.',
  verdict_not_incomplete: 'Verify no longer reports missing proof, so there is nothing to accept with exceptions.',
  not_at_gate: 'This item is no longer at Review & close.',
  reason_blank: 'Every open line needs a reason.',
  exceptions_mismatch: 'Give exactly one reason for each open line.',
  pin_needed: 'Enter the gate PIN to accept with exceptions.',
  human_gate_key_required: 'Enter the gate PIN to accept with exceptions.',
  network: 'No answer from the server. Try again.',
}

export function AcceptWithExceptionsDialog({ itemId, offer, onSubmit, onClose }) {
  const [reasons, setReasons] = useState(() => offer.openLines.map(() => ''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inFlight = useRef(false)
  const panelRef = useRef(null)
  const ready = reasons.every((reason) => reason.trim() !== '')

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
    const exceptions = offer.openLines.map((line, i) => ({ lineId: line.id, reason: reasons[i].trim() }))
    new Promise((resolve) => resolve(onSubmit(itemId, exceptions, offer.linesHash)))
      .then(() => {
        inFlight.current = false
        onClose()
      })
      .catch((err) => {
        inFlight.current = false
        setBusy(false)
        setError(ERRORS[err?.message] || 'The accept did not go through. Try again.')
      })
  }

  return (
    <div className="composer">
      <div className="composer__scrim" onClick={busy ? undefined : onClose} />
      <form
        className="composer__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="accept-exceptions-title"
        ref={panelRef}
        tabIndex={-1}
        onSubmit={submit}
      >
        <div className="composer__title" id="accept-exceptions-title">
          Accept with exceptions
        </div>
        <div className="composer__sub">
          <strong>{itemId}</strong> · Verify found no proof for {offer.openLines.length === 1 ? 'this metric line' : 'these metric lines'}. Give a
          reason for each. The reasons are kept on the closed item and cannot be changed.
        </div>
        {offer.openLines.map((line, i) => (
          <label key={line.id} className="composer__field">
            <span className="composer__field-label">
              Line {line.id}: {line.text}
            </span>
            <textarea
              className="composer__input"
              aria-label={`Reason for metric line ${line.id}`}
              value={reasons[i]}
              maxLength={2000}
              onChange={(e) => {
                const value = e.target.value
                setReasons((list) => list.map((reason, j) => (j === i ? value : reason)))
              }}
            />
          </label>
        ))}
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
            {busy ? 'Closing…' : 'Close with exceptions'}
          </button>
        </div>
      </form>
    </div>
  )
}

// The button beside Approve, and the dialog it opens.
export default function AcceptWithExceptionsButton({ item, onSubmit, disabled = false }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="btn-gate-feedback" disabled={disabled} aria-busy={disabled || undefined} onClick={() => setOpen(true)}>
        Accept with exceptions
      </button>
      {open && (
        <AcceptWithExceptionsDialog itemId={item.id} offer={item.acceptWithExceptions} onSubmit={onSubmit} onClose={() => setOpen(false)} />
      )}
    </>
  )
}

// HO-844: every exception an item was accepted with, newest decision first,
// each with the metric line as it read then and its reason.
export function ExceptionsList({ exceptions }) {
  const decisions = []
  for (const exception of exceptions) {
    const last = decisions.at(-1)
    if (last && last.id === exception.decisionId) last.rows.push(exception)
    else decisions.push({ id: exception.decisionId, by: exception.decidedBy, at: exception.createdAt, rows: [exception] })
  }
  return (
    <section className="step-card__exceptions" aria-label="Accepted with exceptions">
      <div className="step-card__exceptions-title">Accepted with exceptions</div>
      {decisions.map((decision) => (
        <div key={decision.id}>
          <div className="step-card__queued-by">
            {decision.by} · {decision.at}
          </div>
          <ul className="step-card__findings">
            {decision.rows.map((row) => (
              <li key={row.id}>
                <strong>Line {row.lineId}:</strong> {row.metricLine} — {row.reason}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}
