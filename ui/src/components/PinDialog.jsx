import { useEffect, useRef, useState } from 'react'
import { setPinRequester } from '../api'

// HZ-704: the one in-page gate PIN dialog. Every PIN-protected request (gates
// and Admin) goes through serverApi's pinFetch, which asks here only when the
// server answers 401 — the session is not PIN-verified, or the PIN was wrong
// (`retry`). A correct PIN verifies the server session for 12 hours, so the
// dialog does not open again in that time. The typed PIN lives only in this
// dialog's state and the one request that sends it; it is never stored.
// Requests that need the PIN at the same time share one dialog and its answer.
export function PinDialogProvider({ children }) {
  const [ask, setAsk] = useState(null)
  const pending = useRef(null)

  useEffect(() => {
    setPinRequester(({ retry = false } = {}) => {
      if (pending.current) return pending.current
      pending.current = new Promise((resolve) => {
        setAsk({
          retry,
          answer: (pin) => {
            pending.current = null
            setAsk(null)
            resolve(pin || null)
          },
        })
      })
      return pending.current
    })
    return () => setPinRequester(null)
  }, [])

  return (
    <>
      {children}
      {ask && <PinDialog retry={ask.retry} onSubmit={ask.answer} onCancel={() => ask.answer(null)} />}
    </>
  )
}

function PinDialog({ retry, onSubmit, onCancel }) {
  const [pin, setPin] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  const submit = (e) => {
    e.preventDefault()
    if (pin) onSubmit(pin)
  }

  return (
    <div className="composer composer--pin">
      <div className="composer__scrim" onClick={onCancel} />
      <form
        className="composer__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pin-dialog-title"
        aria-describedby="pin-dialog-sub"
        onSubmit={submit}
      >
        <div className="composer__title" id="pin-dialog-title">
          Enter your gate PIN
        </div>
        <div className="composer__sub" id="pin-dialog-sub">
          Once per browser session: it covers gates and Admin changes here for up to 12 hours, until you Lock or sign
          out. Lost it? Regenerate it in Admin → Your PIN and API tokens.
        </div>
        {retry && (
          <div className="gh-error" role="alert">
            PIN incorrect — try again.
          </div>
        )}
        <label className="composer__field">
          <span className="composer__field-label">Gate PIN</span>
          <input
            ref={inputRef}
            className="field__input"
            type="password"
            autoComplete="one-time-code"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </label>
        <div className="composer__actions">
          <button type="button" className="composer__cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="composer__submit" style={{ background: 'var(--primary)' }} disabled={!pin}>
            Continue
          </button>
        </div>
      </form>
    </div>
  )
}
