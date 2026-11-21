import { useEffect, useRef, useState } from 'react'
import { regenerateGatePin, setGatePin } from '../../api'

// HZ-935: Admin's "Reset PIN" dialog, modelled on PinDialog. Two ways in: type
// your own 6 digits (twice), or have the server generate a random PIN and show
// it here once. Either way the server stores only a hash and locks every
// session. Every PIN lives only in this dialog's state — never in storage —
// and is gone when the dialog closes, because the panel unmounts it.
//
// The checks here only save a round trip; the server re-validates every PIN
// and is the only one that knows the weak-PIN list, so 'pin_weak' comes from
// its reply.

const PIN_LENGTH = 6

// The first inline problem with what was typed, or null.
function localError(pin, confirm) {
  if (/[^0-9]/.test(pin)) return { field: 'pin', text: 'Digits only — 0 to 9.' }
  if (pin.length !== PIN_LENGTH) return { field: 'pin', text: `Enter exactly ${PIN_LENGTH} digits.` }
  if (confirm !== pin) return { field: 'confirm', text: "The two PINs don't match." }
  return null
}

const SERVER_ERRORS = {
  pin_weak: 'That PIN is too easy to guess — avoid one repeated digit or a straight run like 123456.',
  pin_format: `Enter exactly ${PIN_LENGTH} digits, 0 to 9.`,
  pin_mismatch: "The two PINs don't match.",
  login_required: 'Your login has expired — sign in again, then reset your PIN.',
  csrf_required: 'That request was refused — reload the page and try again.',
  cross_site_refused: 'That request was refused — reload the page and try again.',
}
const serverError = (err) =>
  (err?.code && Object.hasOwn(SERVER_ERRORS, err.code) && SERVER_ERRORS[err.code]) ||
  (err?.message && Object.hasOwn(SERVER_ERRORS, err.message) && SERVER_ERRORS[err.message]) ||
  "Couldn't reset your PIN — check your connection and try again. Your PIN is unchanged."

const TABS = [
  { key: 'manual', label: 'Choose my own' },
  { key: 'random', label: 'Generate random' },
]

export function ResetPinDialog({ onClose, onReset }) {
  const [tab, setTab] = useState('manual')
  const [pin, setPin] = useState('')
  const [confirm, setConfirm] = useState('')
  const [fieldError, setFieldError] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  // 'set' after a chosen PIN is stored; the generated PIN after a random reset.
  const [done, setDone] = useState(null)
  const [copied, setCopied] = useState(false)
  const pinRef = useRef(null)

  // Closing mid-request is ignored: a random reset replaces the PIN on the
  // server, so the one reply showing it must reach this dialog.
  const close = () => {
    if (!busy) onClose()
  }
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    pinRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const choose = (key) => {
    setTab(key)
    setFieldError(null)
    setError(null)
  }

  const submitChosen = async (e) => {
    e.preventDefault()
    if (busy) return
    const problem = localError(pin, confirm)
    setFieldError(problem)
    setError(null)
    if (problem) return
    setBusy(true)
    try {
      await setGatePin(pin, confirm)
      setPin('')
      setConfirm('')
      setDone('set')
      onReset()
    } catch (err) {
      setError(serverError(err))
    } finally {
      setBusy(false)
    }
  }

  const generate = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await regenerateGatePin()
      setDone({ pin: result.pin })
      onReset()
    } catch (err) {
      setError(serverError(err))
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(done.pin)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="composer composer--pin">
      <div className="composer__scrim" data-testid="reset-pin-scrim" onClick={close} />
      <div className="composer__panel" role="dialog" aria-modal="true" aria-labelledby="reset-pin-title" aria-describedby="reset-pin-sub">
        <div className="composer__title" id="reset-pin-title">
          Reset your gate PIN
        </div>

        {done ? (
          <>
            <div className="composer__sub" id="reset-pin-sub">
              {done === 'set' ? 'Your new PIN is set.' : 'Your PIN has been replaced.'} Every open session is locked and
              asks for the new PIN at its next gate or Admin change.
            </div>
            {done !== 'set' && (
              <div className="admin-status" role="status">
                <span className="admin-status__dot" style={{ background: 'var(--success)' }} />
                Your new PIN:{' '}
                <strong data-testid="reset-pin-value" style={{ fontFamily: 'var(--font-mono)', marginLeft: 4 }}>
                  {done.pin}
                </strong>
                <button type="button" className="composer__cancel" style={{ marginLeft: 'auto' }} onClick={copy}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            )}
            {done !== 'set' && (
              <div className="composer__hint">Shown once, never saved — copy it now. Closing this dialog hides it for good.</div>
            )}
            <div className="composer__actions">
              <button type="button" className="composer__submit composer__submit--primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="composer__sub" id="reset-pin-sub">
              Choose your own 6 digits, or have Horizon generate a random PIN. The server keeps only a hash; this browser
              never stores it.
            </div>
            <div className="project-tabs" role="tablist" aria-label="How to reset">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={t.key === tab}
                  className={`project-tabs__tab${t.key === tab ? ' project-tabs__tab--on' : ''}`}
                  onClick={() => choose(t.key)}
                  disabled={busy}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {tab === 'manual' ? (
              <form role="tabpanel" aria-label="Choose my own" onSubmit={submitChosen} noValidate>
                <label className="composer__field">
                  <span className="composer__field-label">New PIN</span>
                  <input
                    ref={pinRef}
                    className="field__input"
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    value={pin}
                    aria-invalid={fieldError?.field === 'pin' || undefined}
                    onChange={(e) => setPin(e.target.value)}
                  />
                </label>
                {fieldError?.field === 'pin' && (
                  <div className="field__error" role="alert">
                    {fieldError.text}
                  </div>
                )}
                <label className="composer__field">
                  <span className="composer__field-label">Confirm PIN</span>
                  <input
                    className="field__input"
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    value={confirm}
                    aria-invalid={fieldError?.field === 'confirm' || undefined}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </label>
                {fieldError?.field === 'confirm' && (
                  <div className="field__error" role="alert">
                    {fieldError.text}
                  </div>
                )}
                <div className="composer__hint">
                  Exactly 6 digits. Not one repeated digit, and not a straight run like 123456 or 654321.
                </div>
                {error && (
                  <div className="gh-error" role="alert">
                    {error}
                  </div>
                )}
                <div className="composer__actions">
                  <button type="button" className="composer__cancel" onClick={close} disabled={busy}>
                    Cancel
                  </button>
                  <button type="submit" className="composer__submit composer__submit--primary" disabled={busy}>
                    {busy ? 'Working…' : 'Set PIN'}
                  </button>
                </div>
              </form>
            ) : (
              <div role="tabpanel" aria-label="Generate random">
                <div className="composer__hint">
                  Generating replaces your current PIN straight away and locks every session. The new PIN is shown
                  once, here — copy it before you close this dialog.
                </div>
                {error && (
                  <div className="gh-error" role="alert">
                    {error}
                  </div>
                )}
                <div className="composer__actions">
                  <button type="button" className="composer__cancel" onClick={close} disabled={busy}>
                    Cancel
                  </button>
                  <button type="button" className="composer__submit composer__submit--primary" onClick={generate} disabled={busy}>
                    {busy ? 'Working…' : 'Generate and replace my PIN'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
