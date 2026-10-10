// Renders both dependency directions straight from the API payload —
// item.blockedBy (what holds this item up) and item.dependents (what waits
// behind it). No client-side derivation (HZ-95): the fields are trusted as
// given, same policy as StatusPill reading itemStatus().
//
// The full form is also the one place a human removes a dependency (HZ-310):
// an X beside each "Blocked by" entry, and (HZ-354) beside each "Blocks"
// entry, which removes that dependent's link to this item. Success changes
// nothing locally — the server's SSE snapshot drops the edge from this badge
// and the board card.
//
// HZ-379: the full form also lists every item this one filed for itself
// (item.spawned, open or closed) and links back to the item that filed this
// one (item.spawnedBy). Read-only: the dependency edges above are what block.

import { Fragment, useEffect, useState } from 'react'

function abandonedSuffix(entry) {
  return entry.abandoned ? ' (abandoned)' : ''
}

// The id is the actionable half of a dependency — "blocked by HZ-104" can be
// acted on, "blocked by Artifact context: fill the budget..." cannot. The API
// has always returned it; it was previously used only as a React key.
// Relative to the vite base, same as App's own routing ('' at the dev root,
// '/horizon' under the production subpath). HZ-365: the board card's
// "See what to do" link uses it too.
const PREFIX = import.meta.env.BASE_URL.replace(/\/$/, '')

export function itemHref(id) {
  return `${PREFIX}/${id.toLowerCase()}`
}

// Tooltip text: id first so the hover list is scannable by id too.
function tooltip(entries) {
  return entries.map((e) => `${e.id} — ${e.title}${abandonedSuffix(e)}`).join(', ')
}

// A dependency entry in the detail lists: the id links to the item, the title
// stays in its own element so it remains addressable on its own.
// onRemove is passed only in the full form. removeLabel names what the X
// removes, from the point of view of the list it sits in.
function DepEntry({ entry, abandonedNote, onRemove, pending, error, removeLabel = `Remove dependency on ${entry.id}` }) {
  return (
    <li>
      <a className="dep-detail__id" href={itemHref(entry.id)}>
        {entry.id}
      </a>{' '}
      <span className="dep-detail__title">{entry.title}</span>
      {entry.abandoned && <span className="dep-detail__abandoned">{abandonedNote}</span>}
      {onRemove && (
        <button
          type="button"
          className="dep-detail__remove"
          aria-label={removeLabel}
          title={removeLabel}
          disabled={pending}
          onClick={() => onRemove(entry.id)}
        >
          ×
        </button>
      )}
      {error && (
        <span className="dep-detail__error" role="alert">
          Couldn't remove: {error}
        </span>
      )}
    </li>
  )
}

// One list's remove state. Ids with a remove in flight or already confirmed
// stay pending (X disabled) until the snapshot drops them from the list, so a
// second click can't race the SSE update into a false not_found. Each list
// keeps its own state: a blocker and a dependent can share an id.
function useRemoveState(entries, request) {
  const [pending, setPending] = useState(() => new Set())
  const [errors, setErrors] = useState({})
  const key = entries.map((e) => e.id).join(',')

  useEffect(() => {
    const open = new Set(key.split(','))
    setPending((prev) => {
      const next = new Set([...prev].filter((id) => open.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [key])

  async function remove(id) {
    if (pending.has(id)) return
    setPending((prev) => new Set(prev).add(id))
    setErrors((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    try {
      await request(id)
    } catch (err) {
      setErrors((prev) => ({ ...prev, [id]: err?.message || 'request failed' }))
      setPending((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  return {
    remove,
    pending: (id) => pending.has(id),
    error: (id) => (Object.hasOwn(errors, id) ? errors[id] : undefined),
  }
}

// compact=true is the board-card form: one short pill per direction.
// compact=false is the tracker-detail form: a labelled list per direction,
// naming every blocker/dependent, not just the first.
export default function DependencyBadge({ item, compact = false, onRemove }) {
  const blockedBy = item.blockedBy || []
  const dependents = item.dependents || []
  const spawned = item.spawned || []
  const spawnedBy = item.spawnedBy || null
  // Both Xs go through the same onRemove(dependentId, blockerId) request.
  const blockers = useRemoveState(blockedBy, (depId) => onRemove(item.id, depId))
  const waiting = useRemoveState(dependents, (dependentId) => onRemove(dependentId, item.id))

  const hasSpawnLinks = !compact && (spawned.length > 0 || spawnedBy)
  if (blockedBy.length === 0 && dependents.length === 0 && !hasSpawnLinks) return null

  if (compact) {
    return (
      <span className="dep-badges">
        {blockedBy.length > 0 && (
          <span className="dep-pill dep-pill--blocked" title={tooltip(blockedBy)}>
            {/* HZ-335: names every blocker as a link. stopPropagation keeps
                a link click from also opening the card underneath. */}
            Blocked by{' '}
            {blockedBy.map((b, i) => (
              <Fragment key={b.id}>
                {i > 0 && ', '}
                <a className="dep-pill__id" href={itemHref(b.id)} onClick={(e) => e.stopPropagation()}>
                  {b.id}
                </a>
                {abandonedSuffix(b)}
              </Fragment>
            ))}
          </span>
        )}
        {dependents.length > 0 && (
          <span className="dep-pill dep-pill--dependents" title={tooltip(dependents)}>
            Blocks {dependents.length}
          </span>
        )}
      </span>
    )
  }

  return (
    <div className="dep-detail">
      {blockedBy.length > 0 && (
        <div className="dep-detail__section dep-detail__section--blocked">
          <div className="dep-detail__label dep-detail__label--blocked">Blocked by</div>
          <ul className="dep-detail__list">
            {blockedBy.map((b) => (
              <DepEntry
                key={b.id}
                entry={b}
                abandonedNote=" — abandoned, will never close; remove or replace this dependency"
                onRemove={onRemove ? blockers.remove : undefined}
                pending={blockers.pending(b.id)}
                error={blockers.error(b.id)}
              />
            ))}
          </ul>
        </div>
      )}
      {dependents.length > 0 && (
        <div className="dep-detail__section dep-detail__section--dependents">
          <div className="dep-detail__label dep-detail__label--dependents">Blocks</div>
          <ul className="dep-detail__list">
            {dependents.map((d) => (
              <DepEntry
                key={d.id}
                entry={d}
                abandonedNote=" — abandoned"
                onRemove={onRemove ? waiting.remove : undefined}
                pending={waiting.pending(d.id)}
                error={waiting.error(d.id)}
                removeLabel={`Remove ${d.id}'s dependency on ${item.id}`}
              />
            ))}
          </ul>
        </div>
      )}
      {spawned.length > 0 && (
        <div className="dep-detail__section dep-detail__section--spawned">
          <div className="dep-detail__label dep-detail__label--spawned">Spawned</div>
          <ul className="dep-detail__list">
            {spawned.map((c) => (
              <li key={c.id}>
                <a className="dep-detail__id" href={itemHref(c.id)}>
                  {c.id}
                </a>{' '}
                <span className="dep-detail__title">{c.title}</span>
                {c.closed && <span className="dep-detail__closed"> — closed</span>}
                {c.abandoned && <span className="dep-detail__abandoned"> — abandoned</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {spawnedBy && (
        <div className="dep-detail__section dep-detail__section--spawned">
          <div className="dep-detail__label dep-detail__label--spawned">Spawned by</div>
          <ul className="dep-detail__list">
            <li>
              <a className="dep-detail__id" href={itemHref(spawnedBy.id)}>
                {spawnedBy.id}
              </a>{' '}
              <span className="dep-detail__title">{spawnedBy.title}</span>
            </li>
          </ul>
        </div>
      )}
    </div>
  )
}
