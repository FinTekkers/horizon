// HZ-318: the live feed's deltas. Pure — no I/O; app.js's flushStream() is the
// only caller.
//
// The feed used to send every tab the whole board on every store change
// (9.4 MB on 2026-10-06, ~47 GB/day of egress). Now a tab gets one full slim
// snapshot on connect, then only what changed: the diff below compares each
// item's JSON against what was last sent. Diffing the real snapshot means no
// store mutation path has to name the item it touched — a change cannot be
// missed.
//
// A baseline is { items: Map<id, json>, order: string, top: Map<key, json> }.
// Its top-level keys are read off the snapshot itself (everything but `items`),
// so a key added to snapshot() later shows up in deltas with no second list.

function orderKey(ids) {
  return JSON.stringify(ids)
}

export function makeBaseline(snapshot) {
  const items = new Map()
  for (const item of snapshot.items) items.set(item.id, JSON.stringify(item))
  const top = new Map()
  for (const key of Object.keys(snapshot)) {
    if (key !== 'items') top.set(key, JSON.stringify(snapshot[key]))
  }
  return { items, order: orderKey([...items.keys()]), top }
}

// { delta: { upserts, removed, top, order? } | null, baseline } — delta is null
// when nothing changed. `order` (every id, board order) is only sent when the
// id list itself changed; `removed` holds ids that left the snapshot.
export function diffSnapshot(baseline, snapshot) {
  const next = makeBaseline(snapshot)
  const upserts = []
  for (const item of snapshot.items) {
    if (baseline.items.get(item.id) !== next.items.get(item.id)) upserts.push(item)
  }
  const removed = [...baseline.items.keys()].filter((id) => !next.items.has(id))
  const top = {}
  for (const [key, json] of next.top) {
    if (baseline.top.get(key) !== json) top[key] = snapshot[key]
  }
  const orderChanged = baseline.order !== next.order
  if (!upserts.length && !removed.length && !Object.keys(top).length && !orderChanged) {
    return { delta: null, baseline: next }
  }
  const delta = { upserts, removed, top }
  if (orderChanged) delta.order = snapshot.items.map((item) => item.id)
  return { delta, baseline: next }
}
