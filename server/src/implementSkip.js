// HO-902: why Implement opens no PR for an sl item. An sl item's change is
// one Phabricator diff (HO-877), never a GitHub PR, so the step summary and
// the activity feed name the item and say so instead of falling through to the
// generic "no GitHub — PR skipped" text, or to a pushed branch with no word.
//
// A leaf: it imports nothing. The caller passes backendOf(item.repo), so the
// sl check is by the repo's tracker backend, never by `issue == null` (a local
// demo item has a null issue too). The caretaker may import it as well.

// Why Implement opens no PR for this item, or null for any non-sl item.
// done: what the step did, e.g. "code pushed to horizon/ho-12" (optional).
export function slImplementReason(item, backend, { done = null } = {}) {
  if (!item?.repo || backend !== 'sl') return null
  return `sl item ${item.id}: ${done ? `${done}, but ` : ''}no PR is created for sl items`
}
