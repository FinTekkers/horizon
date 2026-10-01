import { useEffect, useRef } from 'react'

// Resolving conflicts takes minutes and the request returns nothing until it
// finishes, so a bare button looked broken and got pressed again — each press
// started another resolver in the same workspace (HZ-125, HZ-157). This dialog
// says what is about to happen before anything starts, shows that it is
// running, and reports what actually happened when the server answers.
//
// phase: 'confirm' | 'running' | 'done'. `result` is the server's
// {ok, resolved, escalated, error} once phase is 'done'.
export const RESOLVE_STEPS = [
  'Merge the latest main into the item’s branch.',
  'If the conflict is small (a few files, a few dozen lines), an agent edits only the conflicting sections. Code outside them cannot change.',
  'Run the repo’s full checks: unit tests, linters and the end-to-end suite.',
  'A reviewer checks only the resolution, not the rest of the PR, which has already passed review.',
  'Push the branch. The PR becomes mergeable and the item stays here at Accept the code, for you.',
]

function resultMessage(result) {
  if (!result || result.ok === false) {
    const why = result?.error ? ` (${result.error.replaceAll('_', ' ')})` : ''
    return { tone: 'bad', title: 'Couldn’t start conflict resolution', body: `Nothing was changed${why}. You can try again.` }
  }
  if (result.resolved) {
    return {
      tone: 'good',
      title: 'Conflicts resolved',
      body: 'The branch was merged with main, checked, reviewed and pushed. The PR is mergeable and the item is back at Accept the code. The activity log has the details.',
    }
  }
  return {
    tone: 'warn',
    title: 'Sent back to the implement agent',
    body: 'The conflict was too large or uncertain for the narrow fix, or its checks or review failed. The implement agent will merge main, resolve the conflicts and re-run the checks, then the PR is reviewed again. The activity log names the reason.',
  }
}

export default function ResolveConflictsDialog({ itemId, pr, phase, result, onConfirm, onClose }) {
  const panelRef = useRef(null)

  useEffect(() => {
    panelRef.current?.focus()
  }, [phase])

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'Enter' && phase === 'confirm') {
        e.preventDefault()
        onConfirm()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [phase, onConfirm, onClose])

  const done = phase === 'done' ? resultMessage(result) : null

  return (
    <div className="composer">
      <div className="composer__scrim" onClick={onClose} />
      <div
        className="composer__panel resolve-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="resolve-dialog-title"
        aria-describedby="resolve-dialog-body"
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="composer__title" id="resolve-dialog-title">
          {phase === 'confirm' && 'Resolve merge conflicts?'}
          {phase === 'running' && 'Resolving conflicts…'}
          {phase === 'done' && done.title}
        </div>
        <div className="composer__sub">
          <strong>{itemId}</strong>
          {pr != null && <> · PR #{pr}</>}
        </div>

        <div className="resolve-dialog__body" id="resolve-dialog-body">
          {phase === 'confirm' && (
            <>
              <p>An agent will try to fix the conflicts without redoing the work:</p>
              <ol className="resolve-dialog__steps">
                {RESOLVE_STEPS.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
              <p>
                If the conflict is too large, or the checks or review fail, the item goes back to the implement agent
                for a full implement and review cycle instead. This usually takes <strong>3 to 10 minutes</strong>.
              </p>
            </>
          )}
          {phase === 'running' && (
            <p className="resolve-dialog__running">
              <span className="resolve-dialog__spinner" aria-hidden="true" />
              Working on it. This usually takes 3 to 10 minutes. You can close this window; the work carries on, and the
              item’s activity log shows the result. <strong>Don’t start it again.</strong>
            </p>
          )}
          {phase === 'done' && <p className={`resolve-dialog__result resolve-dialog__result--${done.tone}`}>{done.body}</p>}
        </div>

        <div className="composer__actions">
          {phase === 'confirm' && (
            <>
              <button className="composer__cancel" onClick={onClose}>
                Cancel
              </button>
              <button className="composer__submit" onClick={onConfirm}>
                Resolve conflicts
              </button>
            </>
          )}
          {phase !== 'confirm' && (
            <button className="composer__cancel" onClick={onClose}>
              {phase === 'running' ? 'Close (keeps running)' : 'Close'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
