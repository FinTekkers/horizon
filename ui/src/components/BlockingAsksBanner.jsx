// HZ-730: the item's open blocking asks, prominently above its page: work a
// step said must be filed before this item can go on. Each is an AskCard, so
// the owner files or dismisses it in place.
//
// HZ-731: item.startHold (server/src/store.js) says what Implement or Execute
// waits for — an open blocking ask, or the item it filed until that merges or
// closes. It shows here even once no ask is open, since a filed ask leaves
// the open list while its item is still unmerged.
//
// HZ-802: a filed ask's hold has a Release, with the gate PIN and a reason —
// the owner's lever when that item will never merge.

import { useState } from 'react'
import AskCard, { effectiveDraft } from './AskCard'
import { itemHref } from './DependencyBadge'
import { releaseAsk } from '../api'

export const blockingAsks = (item) => (item.asks || []).filter((a) => a.kind === 'blocking')

const RELEASE_ERRORS = {
  pin_needed: 'The gate PIN is needed.',
  network: 'No answer from the server. Try again.',
  human_gate_key_required: 'Gate PIN incorrect.',
  reason_required: 'Say why the hold is released.',
  ask_not_filed: 'This ask is no longer filed.',
}
const releaseErrorText = (err) =>
  Object.hasOwn(RELEASE_ERRORS, err?.message ?? '') ? RELEASE_ERRORS[err.message] : `Failed: ${err?.message || 'unknown error'}`

function ReleaseHold({ item, hold }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const submit = async () => {
    if (busy || !reason.trim()) return
    setBusy(true)
    setError(null)
    try {
      await releaseAsk(item.id, hold.askId, reason.trim())
      setOpen(false)
    } catch (err) {
      setError(releaseErrorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="ask-banner__release">
      {open ? (
        <form
          className="ask-card__dismiss"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <textarea
            className="ask-card__reason"
            aria-label="Reason for releasing the hold"
            placeholder={`Why can “${hold.step}” go ahead without ${hold.filedItem.id}?`}
            maxLength={500}
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="ask-card__actions">
            <button type="submit" className="btn-approve" disabled={busy || !reason.trim()}>
              Release with reason
            </button>
            <button type="button" className="ask-card__cancel" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="ask-card__actions">
          <button type="button" className="btn-reject" onClick={() => setOpen(true)} title={`Stop waiting for ${hold.filedItem.id}`}>
            Release
          </button>
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

function StartHold({ item, hold }) {
  if (hold.filedItem) {
    return (
      <>
        <div className="ask-banner__hold" data-testid="ask-start-hold">
          Waiting for{' '}
          <a href={itemHref(hold.filedItem.id)} title={hold.filedItem.title}>
            {hold.filedItem.id}
          </a>{' '}
          to merge or close before “{hold.step}”
        </div>
        <ReleaseHold key={hold.askId} item={item} hold={hold} />
      </>
    )
  }
  return (
    <div className="ask-banner__hold" data-testid="ask-start-hold">
      Waiting for ask “{hold.title}” before “{hold.step}”
    </div>
  )
}

export default function BlockingAsksBanner({ item }) {
  const asks = blockingAsks(item)
  const hold = item.startHold || null
  if (asks.length === 0 && !hold) return null
  return (
    <section className="ask-banner" role="alert" aria-label="Blocking asks">
      {hold && <StartHold item={item} hold={hold} />}
      {asks.map((ask) => (
        <div key={ask.id} className="ask-banner__ask">
          <div className="ask-banner__headline">This item needs “{effectiveDraft(ask).title}” filed first</div>
          <AskCard item={item} ask={ask} />
        </div>
      ))}
    </section>
  )
}
