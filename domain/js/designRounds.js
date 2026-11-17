// HO-853: what the first gate's design panel and the tracker's sub-step row
// read off an item's design sub-step — the rounds HO-851 serves
// (`item.substeps[].rounds`, `pendingRound`) and the canvas link each round's
// run made (HO-850's canvas line, served as the round's `canvasUrl`).
//
// A canvas link is only ever drawn through safeCanvasUrl: an absolute https
// URL with no user or password in it, else nothing. The server applies it
// before serving a round, and the UI again before drawing one.
//
// Pure: no I/O, and no move rule. Which step a send-back goes to is the
// server's (item.moves), never worked out here.

// The URL, normalised, when it is an absolute https: URL with no credentials
// in it; else null.
export function safeCanvasUrl(value) {
  if (typeof value !== 'string' || value === '') return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null
  return url.href
}

// The sub-step's rounds, oldest first, or [] for a sub-step that has none
// (any sub-step but a design one).
export function roundsOf(sub) {
  return Array.isArray(sub?.rounds) ? sub.rounds : []
}

export function latestRoundOf(sub) {
  return roundsOf(sub).at(-1) ?? null
}

// The round number the sub-step's row shows: the round in flight while one
// runs, else the latest stored one; null for a sub-step with no rounds.
export function roundNumberOf(sub) {
  const pending = sub?.pendingRound
  if (pending && Number.isInteger(pending.round)) return pending.round
  const latest = latestRoundOf(sub)
  return Number.isInteger(latest?.round) ? latest.round : null
}

// The item's design sub-step as the first gate's design panel shows it — the
// one item.designSpec names — or null.
export function designSubstepFor(item) {
  const id = item?.designSpec?.substepId
  if (typeof id !== 'string') return null
  return (Array.isArray(item.substeps) ? item.substeps : []).find((s) => s?.id === id) ?? null
}
