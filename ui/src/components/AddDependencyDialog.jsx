// HZ-365: the rule-block banner's Add dependency. Picks the upstream item that
// delivers what the agent needs, or files a new one, and links it through
// HZ-346's existing POST /api/items/:id/dependencies. A closed item is
// offered too: linking one that already shipped the fix releases the block
// and restarts implement at once (store.releaseRuleBlockIfSatisfied).

import { useState } from 'react'
import { isAbandoned, isClosed } from '../../../domain/js/lifecycle.js'

export default function AddDependencyDialog({ item, items = [], initialError = null, onAdd, onFileNew, onClose }) {
  const blockerIds = new Set((item.blockedBy || []).map((b) => b.id))
  const options = items.filter((it) => it.id !== item.id && !blockerIds.has(it.id) && !isAbandoned(it))
  const [dependsOnId, setDependsOnId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(initialError)

  const add = async () => {
    if (!dependsOnId || busy) return
    setBusy(true)
    setError(null)
    try {
      await onAdd(item.id, dependsOnId)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="composer">
      <div className="composer__scrim" onClick={onClose} />
      <div className="composer__panel" role="dialog" aria-modal="true" aria-labelledby="add-dependency-title">
        <div className="composer__title" id="add-dependency-title">
          Add dependency · {item.id}
        </div>
        <div className="composer__sub">
          {item.id} waits for the item you pick and restarts implement once it closes. Picking an item that is
          already closed restarts it now.
        </div>
        <div className="composer__field">
          <label htmlFor="add-dependency-item" className="composer__field-label">
            Blocked by
          </label>
          <select
            id="add-dependency-item"
            className="composer__select"
            value={dependsOnId}
            onChange={(e) => setDependsOnId(e.target.value)}
          >
            <option value="">Pick the upstream item…</option>
            {options.map((it) => (
              <option key={it.id} value={it.id}>
                {it.id} — {it.title}
                {isClosed(it) ? ' (closed)' : ''}
              </option>
            ))}
          </select>
        </div>
        {error && (
          <span className="dep-detail__error" role="alert">
            Couldn't add: {error}
          </span>
        )}
        <div className="composer__actions">
          <button className="composer__cancel" onClick={onFileNew}>
            File a new upstream item
          </button>
          <button className="composer__cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="composer__submit composer__submit--primary" onClick={add} disabled={!dependsOnId || busy}>
            Add dependency
          </button>
        </div>
      </div>
    </div>
  )
}
