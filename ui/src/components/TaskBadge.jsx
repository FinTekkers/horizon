import { isItemKind, itemKindInfo } from '../../../domain/js/lifecycle.js'

// The item's kind (HZ-382), on every board card and tracker header. A change —
// including an item stored before kinds existed, with no kind at all — shows
// nothing, so change cards render as before. Any other kind shows its label
// from domain/steps.json; today that is only Task, hence the name.
// HZ-435: `lane` (laneOf(item)) adds the lane's own badge, e.g. `trivial`;
// null, the full pipeline, adds nothing.
export default function TaskBadge({ kind, lane = null }) {
  const kindBadge = isItemKind(kind) && kind !== 'change' ? <span className="kind-badge">{itemKindInfo(kind).label}</span> : null
  if (!lane) return kindBadge
  return (
    <>
      {kindBadge}
      <span className="kind-badge lane-badge" data-testid="lane-badge">
        {lane}
      </span>
    </>
  )
}
