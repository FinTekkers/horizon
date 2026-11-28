// HZ-976: the order an item's opening sub-steps run in once their anchor
// step finished. Before this only the design sub-step (HO-851) was ever
// entered; every other opening sub-step (HZ-541's golden cases, any
// `artifact` one) was walked past.
//
// At one anchor, design always goes first — it is still entered only by the
// verdict on the anchor's own run (orchestrator.js completeDesignSubstep) —
// then every other opening sub-step, in snapshot order.
//
// Pure: no I/O and no writes. moveItem.js stays the only writer of an item's
// step.

import { substepsAt } from '../../domain/js/substeps.js'
import { DESIGN_OUTPUT } from './designRounds.js'

const OPENING_KIND = 'opening'

// The next non-design opening sub-step at the item's cursor, or null. With
// `afterId` null or a design sub-step's id, the first one; with another
// sub-step's id, the one after it.
export function nextOpeningSubstep(item, afterId = null) {
  const atAnchor = substepsAt(item, item?.cursor)
  const subs = atAnchor.filter((s) => s.kind === OPENING_KIND && s.output !== DESIGN_OUTPUT)
  if (afterId == null || atAnchor.some((s) => s.id === String(afterId) && s.output === DESIGN_OUTPUT)) return subs[0] ?? null
  const at = subs.findIndex((s) => s.id === String(afterId))
  return at === -1 ? null : (subs[at + 1] ?? null)
}
