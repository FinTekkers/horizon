// HZ-730: one open ask the owner can act on — its draft (the reviewer's
// amended one when the verdict is amend), why, the step that asked by name,
// and the HZ-729 reviewer's verdict. File it files the draft as an item;
// Dismiss needs a reason, which goes to the item's next agent step. Both ask
// for the gate PIN. Agent-written text renders as plain React text. HZ-793:
// the reviewer's finding that the ask contradicts its parent item shows too.
// HZ-820: `parentClosed` — a soft ask Horizon dismissed when its item closed
// or was abandoned. It shows why it closed and keeps File it; no Dismiss.

import { useState } from 'react'
import { fileAsk, dismissAsk } from '../api'

const VERDICT_LABELS = { accept: 'Reviewer: accept', amend: 'Reviewer: amend', escalate: 'Reviewer: escalate' }
const ERRORS = {
  pin_needed: 'The gate PIN is needed.',
  network: 'No answer from the server. Try again.',
  human_gate_key_required: 'Gate PIN incorrect.',
  ask_not_reviewed: 'Not reviewed yet: File it waits for the review.',
  ask_closed: 'This ask is already closed.',
  repo_not_in_project: 'Its repo is not connected to this item’s project.',
  draft_invalid: 'The draft holds text that cannot be filed.',
  reason_required: 'Say why it is dismissed.',
}
const errorText = (err) => (Object.hasOwn(ERRORS, err?.message ?? '') ? ERRORS[err.message] : `Failed: ${err?.message || 'unknown error'}`)

// The review as the card shows it: whether it finished, its chip and reasons.
export function reviewState(ask) {
  const review = ask.review
  if (!review || !review.verdict || review.status === 'awaiting' || review.status === 'running') {
    return { reviewed: false, label: 'Not reviewed yet', reasons: review?.wait_reason ? [review.wait_reason] : [] }
  }
  const label = review.status === 'done' ? VERDICT_LABELS[review.verdict] || `Reviewer: ${review.verdict}` : 'Review failed: escalated to you'
  const contradiction = review.contradiction?.contradicts === true ? review.contradiction.detail : null
  return { reviewed: true, label, verdict: review.verdict, reasons: review.reasons || [], contradiction }
}

// The draft File it would file.
export function effectiveDraft(ask) {
  const amended = ask.review?.verdict === 'amend' ? ask.review.amended_draft : null
  return amended ? { ...amended, amended: true } : { title: ask.title, repo: ask.repo, outcome: ask.outcome, metric: ask.metric, guardrails: ask.guardrails, amended: false }
}

export default function AskCard({ item, ask, compact = false, parentClosed = false }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [dismissing, setDismissing] = useState(false)
  const [reason, setReason] = useState('')
  const review = reviewState(ask)
  const draft = effectiveDraft(ask)

  const run = async (action) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
      setDismissing(false)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const details = (
    <dl className="ask-card__draft">
      <dt>Outcome</dt>
      <dd>{draft.outcome}</dd>
      <dt>Success metric</dt>
      <dd>{draft.metric}</dd>
      <dt>Guardrails</dt>
      <dd>{draft.guardrails}</dd>
    </dl>
  )

  return (
    <div className={`ask-card ask-card--${ask.kind}${compact ? ' ask-card--compact' : ''}`} data-testid="ask-card">
      <div className="ask-card__head">
        <span className="ask-card__title">{draft.title}</span>
        <span className="ask-card__repo">{draft.repo}</span>
      </div>
      <div className="ask-card__why">
        <span className="ask-card__step">{ask.step}:</span> {ask.why}
      </div>
      {parentClosed && <div className="ask-card__closed">Closed: {ask.dismiss_reason}</div>}
      <div className="ask-card__review">
        <span className={`ask-card__verdict ask-card__verdict--${review.verdict ?? 'none'}`}>{review.label}</span>
        {draft.amended && <span className="ask-card__amended">Reviewer’s amended draft</span>}
        {review.reasons.length > 0 && <span className="ask-card__reasons">{review.reasons.join(' · ')}</span>}
        {review.contradiction && <span className="ask-card__contradiction">Contradicts the parent: {review.contradiction}</span>}
      </div>
      {compact ? (
        <details className="ask-card__more">
          <summary>Draft</summary>
          {details}
        </details>
      ) : (
        details
      )}
      {dismissing ? (
        <form
          className="ask-card__dismiss"
          onSubmit={(e) => {
            e.preventDefault()
            if (reason.trim()) run(() => dismissAsk(item.id, ask.id, reason.trim()))
          }}
        >
          <textarea
            className="ask-card__reason"
            aria-label="Reason for dismissing"
            placeholder="Why is this not needed? The next agent step reads it."
            maxLength={500}
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="ask-card__actions">
            <button type="submit" className="btn-reject" disabled={busy || !reason.trim()}>
              Dismiss with reason
            </button>
            <button type="button" className="ask-card__cancel" disabled={busy} onClick={() => setDismissing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="ask-card__actions">
          <button
            type="button"
            className="btn-approve"
            disabled={busy || !review.reviewed}
            title={review.reviewed ? `File “${draft.title}” on ${draft.repo}` : 'File it waits for the review'}
            onClick={() => run(() => fileAsk(item.id, ask.id))}
          >
            File it
          </button>
          {!parentClosed && (
            <button type="button" className="btn-reject" disabled={busy} onClick={() => setDismissing(true)}>
              Dismiss
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="ask-card__error" role="status">
          {error}
        </div>
      )}
    </div>
  )
}
