import { RecorderError } from './errors.mjs'

// There is no GET /api/items/:id: the board list (`?v=2`, without step
// outputs) is the one item GET, so the recorder reads it and picks its item.
// Every field used here comes from the server's itemView.
export async function pollItem({ apiBase, itemId, token, fetchImpl = fetch }) {
  const res = await fetchImpl(`${apiBase}/items?v=2`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  })
  if (res.status === 401) throw new RecorderError('token rejected (401)', 2)
  if (!res.ok) throw new Error(`board answered ${res.status}`)
  const body = await res.json()
  const item = (body.items || []).find((it) => it.id === itemId)
  if (!item) return null
  const label = item.currentStep?.label ?? `Step ${item.cursor}`
  let done = null
  if (item.abandoned_at) done = 'abandoned'
  else if (item.currentStep?.kind === 'done' || label === 'Closed') done = 'closed'
  return {
    cursor: item.cursor,
    label,
    startedAt: toMs(item.state_since),
    endedAt: done === 'abandoned' ? toMs(item.abandoned_at) : done === 'closed' ? toMs(item.state_since) : null,
    done,
  }
}

// The server sends UTC timestamps either as ISO strings or as SQLite's
// "YYYY-MM-DD HH:MM:SS" (no zone, UTC). null when absent or unparseable.
export function toMs(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number') return value
  const s = String(value)
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}
