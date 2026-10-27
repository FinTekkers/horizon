// HZ-540: reading an item's sub-step snapshot — HZ-538's
// work_item.substeps_json, served as item.substeps — for every place a step is
// drawn or named: the board card, the tracker, the send-back picker, the
// Approvals drawer, gate notices and WhatsApp text, event text.
//
// The snapshot is the only source. Nothing here reads a project's steps.json
// or re-runs `applies`, so an item keeps the sub-steps it was given at intake
// whatever the project file says now.
//
// An item with no snapshot (no definitions, or the switch off) reads [] and
// null everywhere, so every caller falls through to the global step exactly
// as before.
//
// substep_cursor names the sub-step the item is at. It counts only while the
// cursor is on that sub-step's anchor: once the item moves off the anchor it
// is at the global step again.
//
// Pure: no I/O. The server and the UI import it the same way they import
// lifecycle.js.

import { STEPS, reworkTargets } from './lifecycle.js'

// The id shape a send-back target may carry (substeps.js's ID_RE, capped).
export const SUBSTEP_ID_PATTERN = '^[a-z0-9][a-z0-9-]{0,63}$'

const isSubstep = (s) =>
  s !== null && typeof s === 'object' && typeof s.id === 'string' && typeof s.label === 'string' && Number.isInteger(s.anchor)

// The item's snapshot, in order: item.substeps as served, else the raw
// substeps_json column. [] for none or anything unreadable.
export function substepsOf(item) {
  if (Array.isArray(item?.substeps)) return item.substeps.filter(isSubstep)
  if (typeof item?.substeps_json !== 'string') return []
  try {
    const parsed = JSON.parse(item.substeps_json)
    return Array.isArray(parsed) ? parsed.filter(isSubstep) : []
  } catch {
    return []
  }
}

// The sub-steps that follow one global step, in snapshot order.
export function substepsAt(item, anchorIndex) {
  return substepsOf(item).filter((s) => s.anchor === anchorIndex)
}

// The sub-step the item is at, or null.
export function currentSubstep(item) {
  const id = item?.substep_cursor
  if (id == null) return null
  return substepsOf(item).find((s) => s.id === String(id) && s.anchor === item.cursor) ?? null
}

// What to call step `index` of this item: the current sub-step's label when
// the item is at a sub-step of that step, else the global step's label.
export function stepLabel(item, index = item?.cursor) {
  const sub = currentSubstep(item)
  if (sub && sub.anchor === index) return sub.label
  return STEPS[index]?.label ?? null
}

// The sub-steps a send-back from the item's gate may target: each one whose
// anchor is itself a legal numeric target (lifecycle.js reworkTargets — an
// earlier agent step of the item's kind its lane runs). [] off a gate.
// [{ index, substepId, label }], in snapshot order.
export function substepReworkTargets(item) {
  if (STEPS[item?.cursor]?.kind !== 'gate') return []
  const subs = substepsOf(item)
  if (!subs.length) return []
  const anchors = new Set(reworkTargets(item.cursor, undefined, item).map((t) => t.index))
  return subs.filter((s) => anchors.has(s.anchor)).map((s) => ({ index: s.anchor, substepId: s.id, label: s.label }))
}

// A send-back target as one <select> value and back: '12' is the global
// step, '12:security-review' a sub-step of it. decodeTarget('') is null
// (the default target).
export function encodeTarget({ index, substepId = null }) {
  return substepId ? `${index}:${substepId}` : String(index)
}

export function decodeTarget(value) {
  if (typeof value !== 'string' || value === '') return null
  const at = value.indexOf(':')
  const index = Number(at === -1 ? value : value.slice(0, at))
  if (!Number.isInteger(index)) return null
  return { index, substepId: at === -1 ? null : value.slice(at + 1) || null }
}
