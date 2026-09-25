// Renders both dependency directions straight from the API payload —
// item.blockedBy (what holds this item up) and item.dependents (what waits
// behind it). No client-side derivation (HZ-95): the fields are trusted as
// given, same policy as StatusPill reading itemStatus().

function abandonedSuffix(entry) {
  return entry.abandoned ? ' (abandoned)' : ''
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
          <span
            className="dep-pill dep-pill--blocked"
            title={blockedBy.map((b) => `${b.title}${abandonedSuffix(b)}`).join(', ')}
          >
            Blocked by {blockedBy[0].title}
            {abandonedSuffix(blockedBy[0])}
            {blockedBy.length > 1 && ` +${blockedBy.length - 1} more`}
          </span>
        )}
        {dependents.length > 0 && (
          <span className="dep-pill dep-pill--dependents" title={dependents.map((d) => d.title).join(', ')}>
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
              <li key={b.id}>
                {b.title}
                {b.abandoned && (
                  <span className="dep-detail__abandoned"> — abandoned, will never close; remove or replace this dependency</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {dependents.length > 0 && (
        <div className="dep-detail__section dep-detail__section--dependents">
          <div className="dep-detail__label dep-detail__label--dependents">Blocks</div>
          <ul className="dep-detail__list">
            {dependents.map((d) => (
              <li key={d.id}>
                {d.title}
                {d.abandoned && <span className="dep-detail__abandoned"> — abandoned</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
