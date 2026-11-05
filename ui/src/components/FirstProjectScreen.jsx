import { useId, useRef, useState } from 'react'

const NAME_MIN = 2
const NAME_MAX = 80
const REGENERATE_HINT = 'regenerate it in Admin → Your PIN and API tokens.'

// HZ-661: what a signed-in non-owner in no project sees instead of the board —
// a new user, or one removed from their last project. `onCreate` is
// api.createProject (POST /api/projects): the server makes the caller a member
// and sets it as their active project, and the next board frame swaps this
// screen for that project's board, so nothing is kept here on success. It
// calls no owner route and connects no repo.
//
// HZ-773: `pinPending` (/auth/me's gatePinRevealPending) means a fresh sign-up
// who has never seen their gate PIN. "Show my PIN" calls `onRevealPin`
// (api.revealFirstGatePin) once; the PIN is kept in this component's state
// only, and Create waits until "I have saved my PIN" is ticked, so the PIN the
// repo connect asks for is one they were shown.
export default function FirstProjectScreen({ onCreate, pinPending = false, onRevealPin }) {
  const inputId = useId()
  const pinId = useId()
  const [name, setName] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  // null, 'loading', 'shown', 'shown_before' (a 409) or 'failed'.
  const [pinState, setPinState] = useState(null)
  const [pin, setPin] = useState(null)
  const [pinSaved, setPinSaved] = useState(false)
  const revealing = useRef(false)

  const revealPin = async () => {
    if (revealing.current) return
    revealing.current = true
    setPinState('loading')
    try {
      setPin(await onRevealPin())
      setPinState('shown')
    } catch (err) {
      if (err?.code === 'pin_already_shown') {
        setPinState('shown_before')
      } else {
        setPinState('failed')
        revealing.current = false
      }
    }
  }

  const pinBlocksCreate = pinPending && pinState !== 'shown_before' && !(pinState === 'shown' && pinSaved)

  const submit = async (e) => {
    e.preventDefault()
    if (busy || pinBlocksCreate) return
    const trimmed = name.trim()
    if (trimmed.length < NAME_MIN || trimmed.length > NAME_MAX) {
      setError(`A project name is ${NAME_MIN}–${NAME_MAX} characters.`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onCreate(trimmed)
    } catch (err) {
      setError(err?.message || 'Could not create the project')
      setBusy(false)
    }
  }

  return (
    <div className="first-project">
      <div className="first-project__card">
        <h1 className="first-project__title">Set up your first project</h1>
        <p className="first-project__lede">
          You are not in any project yet. Name one to get started — it opens on its own, empty board.
        </p>
        {pinPending && (
          <section className="first-project__pin" aria-label="Your gate PIN">
            <h2 className="first-project__pin-title">Your gate PIN</h2>
            <p className="first-project__pin-text">
              Horizon asks for this PIN before it connects your repository or approves a gate. It is shown once.
            </p>
            {pinState === 'shown' ? (
              <>
                <label className="field__label" htmlFor={pinId}>
                  Gate PIN
                </label>
                <input id={pinId} className="first-project__pin-value" type="text" readOnly value={pin} />
                <p className="first-project__pin-warn" role="status">
                  Save this now — it is not shown again. If you lose it, {REGENERATE_HINT}
                </p>
                <label className="first-project__pin-ack">
                  <input type="checkbox" checked={pinSaved} onChange={(e) => setPinSaved(e.target.checked)} />I have saved my PIN
                </label>
              </>
            ) : pinState === 'shown_before' ? (
              <p className="first-project__pin-warn" role="status">
                Your PIN was already shown, in another tab or window. If you did not save it, {REGENERATE_HINT}
              </p>
            ) : (
              <>
                {pinState === 'failed' && (
                  <div className="gh-error" role="alert">
                    Could not show your PIN. Try again.
                  </div>
                )}
                <button className="first-project__pin-show" type="button" onClick={revealPin} disabled={pinState === 'loading'}>
                  {pinState === 'loading' ? 'Showing…' : 'Show my PIN'}
                </button>
              </>
            )}
          </section>
        )}
        <form onSubmit={submit}>
          <div className="field">
            <label className="field__label" htmlFor={inputId}>
              Project name
            </label>
            <input
              id={inputId}
              className="field__input"
              type="text"
              maxLength={NAME_MAX}
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {error && (
            <div className="gh-error" role="alert">
              {error}
            </div>
          )}
          <button className="first-project__submit" type="submit" disabled={busy || pinBlocksCreate}>
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </form>
      </div>
    </div>
  )
}
