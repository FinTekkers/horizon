import { useId, useState } from 'react'

const NAME_MIN = 2
const NAME_MAX = 80

// HZ-661: what a signed-in non-owner in no project sees instead of the board —
// a new user, or one removed from their last project. `onCreate` is
// api.createProject (POST /api/projects): the server makes the caller a member
// and sets it as their active project, and the next board frame swaps this
// screen for that project's board, so nothing is kept here on success. It
// calls no owner route and connects no repo.
export default function FirstProjectScreen({ onCreate }) {
  const inputId = useId()
  const [name, setName] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
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
          <button className="first-project__submit" type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </form>
      </div>
    </div>
  )
}
