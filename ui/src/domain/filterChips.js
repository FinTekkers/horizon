// HZ-601: the board's filter bar — one removable chip per filter that is
// narrowing the board, read from both stores (boardFilters' hide keys and
// boardNarrowing's view). "Filters · N" is the length of this list, so the
// count and the chips cannot drift apart.
//
// A hide filter is on by default, so its chip shows when it is OFF
// ("Including closed"); removing that chip turns the filter back on.
// chipPatch is the only place that knows how each chip is cleared.

import { PRIORITIES } from '../../../domain/js/priorities.js'
import { FILTERS } from './filters'
import { KIND_OPTIONS } from './narrowing'

const HIDE_PREFIX = 'hide:'

export function activeChips(view, activeFilterKeys, filters = FILTERS) {
  const chips = filters
    .filter((f) => !activeFilterKeys.includes(f.key))
    .map((f) => ({ key: `${HIDE_PREFIX}${f.key}`, label: `Including ${f.noun}` }))
  if (view.waiting) chips.push({ key: 'waiting', label: 'Waiting on me' })
  if (view.priorities.length > 0) {
    chips.push({ key: 'priorities', label: `Priority: ${PRIORITIES.filter((p) => view.priorities.includes(p)).join(', ')}` })
  }
  if (view.kinds.length > 0) {
    chips.push({ key: 'kinds', label: `Kind: ${KIND_OPTIONS.filter((k) => view.kinds.includes(k.key)).map((k) => k.label).join(', ')}` })
  }
  if (view.plan != null) chips.push({ key: 'plan', label: `Plan: ${view.plan}` })
  if (view.substep) chips.push({ key: 'substep', label: 'At a sub-step' })
  return chips
}

// What removing a chip does: `{ hide: key }` turns that hide filter back on;
// `{ view: patch }` is a boardNarrowing.setBoardView patch. Null for a key no
// chip has.
export function chipPatch(key) {
  if (key.startsWith(HIDE_PREFIX)) return { hide: key.slice(HIDE_PREFIX.length) }
  if (key === 'waiting') return { view: { waiting: false } }
  if (key === 'priorities') return { view: { priorities: [] } }
  if (key === 'kinds') return { view: { kinds: [] } }
  if (key === 'plan') return { view: { plan: null } }
  if (key === 'substep') return { view: { substep: false } }
  return null
}
