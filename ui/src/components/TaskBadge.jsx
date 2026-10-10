import { isItemKind, itemKindInfo } from '../../../domain/js/lifecycle.js'

// The item's kind (HZ-382), on every board card and tracker header. A change —
// including an item stored before kinds existed, with no kind at all — shows
// nothing, so change cards render as before. Any other kind shows its label
// from domain/steps.json; today that is only Task, hence the name.
export default function TaskBadge({ kind }) {
  if (!isItemKind(kind) || kind === 'change') return null
  return <span className="kind-badge">{itemKindInfo(kind).label}</span>
}
