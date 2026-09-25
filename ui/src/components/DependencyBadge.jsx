// Renders both dependency directions straight from the API payload —
// item.blockedBy (what holds this item up) and item.dependents (what waits
// behind it). No client-side derivation (HZ-95): the fields are trusted as
// given, same policy as StatusPill reading itemStatus().

function abandonedSuffix(entry) {
  return entry.abandoned ? ' (abandoned)' : ''
}

// The id is the actionable half of a dependency — "blocked by HZ-104" can be
// acted on, "blocked by Artifact context: fill the budget..." cannot. The API
// has always returned it; it was previously used only as a React key.
// Relative to the vite base, same as App's own routing ('' at the dev root,
// '/horizon' under the production subpath).
const PREFIX = import.meta.env.BASE_URL.replace(/\/$/, '')

function itemHref(id) {
  return `${PREFIX}/${id.toLowerCase()}`
}

// Tooltip text: id first so the hover list is scannable by id too.
function tooltip(entries) {
  return entries.map((e) => `${e.id} — ${e.title}${abandonedSuffix(e)}`).join(', ')
}

// A dependency entry in the detail lists: the id links to the item, the title
// stays in its own element so it remains addressable on its own.
function DepEntry({ entry, abandonedNote }) {
  return (
    <li>
      <a className="dep-detail__id" href={itemHref(entry.id)}>
        {entry.id}
      </a>{' '}
      <span className="dep-detail__title">{entry.title}</span>
      {entry.abandoned && <span className="dep-detail__abandoned">{abandonedNote}</span>}
    </li>
  )
}

// compact=true is the board-card form: one short pill per direction.
// compact=false is the tracker-detail form: a labelled list per direction,
// naming every blocker/dependent, not just the first.
export default function DependencyBadge({ item, compact = false }) {
  const blockedBy = item.blockedBy || []
  const dependents = item.dependents || []
  if (blockedBy.length === 0 && dependents.length === 0) return null

  if (compact) {
    return (
      <span className="dep-badges">
        {blockedBy.length > 0 && (
          <span className="dep-pill dep-pill--blocked" title={tooltip(blockedBy)}>
            Blocked by {blockedBy[0].id}
            {abandonedSuffix(blockedBy[0])}
            {blockedBy.length > 1 && ` +${blockedBy.length - 1} more`}
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
              <DepEntry key={d.id} entry={d} abandonedNote=" — abandoned" />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
