import { useEffect, useRef, useState } from 'react'
import { moveDialogTargets, targetFor } from '../domain/stepActions'

// HZ-711: the one dialog for Return to and Retry, on every surface. It shows
// the server's own summary of the move (item.moves): the target step, what is
// redone, which approvals are given again and whether a running step stops,
// plus a note for the step that runs again. Opened without a step (the menu's
// Move to…), it lists the snapshot's return targets with the gate's default
// chosen, then (HZ-920) Close when the snapshot offers it. It reads `item`
// live, so a newer snapshot shows its targets; a failed move keeps the
// dialog, its choice and the note.
//
// HO-853: a shortcut that presets the step can also name its own title, note
// label and submit label, and require the note (`requireNote`): then nothing
// is sent — by click or ⌘/Ctrl+Enter — until the note has text. The defaults
// keep every other caller as it was.
export default function MoveDialog({
  item,
  action,
  stepKey = null,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
  title = null,
  noteLabel = null,
  submitLabel = null,
  requireNote = false,
}) {
  const picker = action === 'return' && stepKey == null
  const choices = picker ? moveDialogTargets(item) : []
  const fallback = (choices.find((t) => t.isDefault) ?? choices[0])?.key ?? null
  const [picked, setChosen] = useState(null)
  // A choice a newer snapshot no longer offers falls back to its default.
  const chosen = picker ? (choices.some((t) => t.key === picked) ? picked : fallback) : stepKey
  const [note, setNote] = useState('')
  // HZ-920: a picked choice is found among the choices — Close is not a return.
  const target = chosen ? (picker ? choices.find((t) => t.key === chosen) ?? null : targetFor(item, action, chosen)) : null
  const noteMissing = requireNote && note.trim() === ''
  const noteRef = useRef(null)

  // Focus goes back to whatever opened the dialog when it closes.
  useEffect(() => {
    const opener = document.activeElement
    noteRef.current?.focus()
    return () => {
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus()
    }
  }, [])

  const confirm = () => {
    if (busy || !target || noteMissing) return
    onConfirm(action, target.key, note.trim())
  }

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        confirm()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const retry = action === 'retry'
  return (
    <div className="composer">
      <div className="composer__scrim" onClick={onCancel} />
      <div className="composer__panel move-dialog" role="dialog" aria-modal="true" aria-labelledby="move-dialog-title" aria-describedby="move-dialog-sub">
        <div className="composer__title" id="move-dialog-title">
          {title ?? (retry ? 'Retry this step' : 'Move to an earlier step')} · {item.id}
        </div>
        <div className="composer__sub" id="move-dialog-sub">
          {item.title}
        </div>
        {picker && (
          <fieldset className="move-dialog__choices">
            <legend className="composer__field-label">Move to</legend>
            {choices.map((t) => (
              <label key={t.key} className="move-dialog__choice">
                <input type="radio" name="move-target" value={t.key} checked={chosen === t.key} onChange={() => setChosen(t.key)} />
                <span>{t.label}</span>
                {t.isDefault && <span className="move-dialog__default">Default</span>}
              </label>
            ))}
          </fieldset>
        )}
        {target ? (
          <div className="move-dialog__summary" data-testid="move-summary">
            <div className="move-dialog__row">
              <span className="composer__field-label">Step</span>
              <span className="move-dialog__target">{target.label}</span>
            </div>
            <div className="move-dialog__row">
              <span className="composer__field-label">What is redone</span>
              <span>{target.redo}</span>
            </div>
            <div className="move-dialog__row">
              <span className="composer__field-label">Approvals given again</span>
              {target.reapprovals?.length > 0 ? (
                <ul className="move-dialog__list" aria-label="Approvals given again">
                  {target.reapprovals.map((label) => (
                    <li key={label}>{label}</li>
                  ))}
                </ul>
              ) : (
                <span>None</span>
              )}
            </div>
            {target.stopsRunning && <div className="move-dialog__stops">The running step stops.</div>}
          </div>
        ) : (
          <div className="move-dialog__gone" role="status">
            This step is no longer offered — the item has moved. Close and choose again.
          </div>
        )}
        <label className="composer__field">
          <span className="composer__field-label">{noteLabel ?? 'Note for the step (optional)'}</span>
          <textarea
            ref={noteRef}
            className="composer__input"
            value={note}
            maxLength={2000}
            placeholder="What should change this time?"
            required={requireNote || undefined}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <div className="composer__hint">⌘/Ctrl + Enter to confirm · Esc to cancel</div>
        {error && <span role="alert">{error}</span>}
        <div className="composer__actions">
          <button type="button" className="composer__cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="composer__submit"
            style={{
              // A named shortcut (HO-853's Request changes) is not a red "Return here".
              background: submitLabel ? 'var(--primary)' : retry ? 'var(--warning)' : 'var(--danger)',
              ...(retry && !submitLabel && { color: 'var(--on-warning)' }),
            }}
            disabled={busy || !target || noteMissing}
            aria-busy={busy || undefined}
            onClick={confirm}
          >
            {submitLabel ?? (retry ? 'Retry' : 'Return here')}
          </button>
        </div>
      </div>
    </div>
  )
}
