// HZ-333: the line the board and the Tracker show for an item waiting in its
// deploy target's queue (the server's `deploy_queue` field), or null when it
// is not queued. The close time is the viewer's local HH:MM.
//
// HZ-481: the line follows the batch through its stages, each from facts the
// server adds to `deploy_queue` (times are the viewer's local HH:MM):
//   open       next horizon deploy (b122) · window closes 00:52 (in 3 min)
//   drain      horizon deploy b122 · waiting for 3 running steps (HZ-449
//              implement, …) · goes ahead by 01:18 at the latest
//   deploying  horizon deploy b122 · deploying since 01:12 · live about 01:14
//   live       b122 live at 01:14 · smoke check running
// "Deploying since" is when the batch started publishing: the drain's end is
// never stored. "Live about" is the drain's end (else now) plus the median of
// the target's last 5 deploys, which also count publish, deploy-hold and
// drain time. A stage missing any of its facts falls back to the HZ-333 line.
const pad = (n) => String(n).padStart(2, '0')

const msOf = (iso) => (typeof iso === 'string' && iso ? Date.parse(iso) : NaN)

function hhmm(ms) {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function stageLabel(q, now) {
  if (!Number.isFinite(q.batch_id)) return null
  const batch = `b${q.batch_id}`
  if (q.status === 'released') {
    const live = msOf(q.live_at)
    return q.batch_status === 'verifying' && Number.isFinite(live) ? `${batch} live at ${hhmm(live)} · smoke check running` : null
  }
  if (q.status !== 'queued') return null
  if (q.batch_status === 'open') {
    const closes = msOf(q.window_closes_at)
    if (!Number.isFinite(closes)) return null
    const mins = Math.ceil((closes - now) / 60000)
    return `next ${q.target} deploy (${batch}) · window closes ${hhmm(closes)}${mins > 0 ? ` (in ${mins} min)` : ''}`
  }
  if (q.batch_status !== 'deploying') return null
  const deadline = msOf(q.drain_deadline)
  const waiting = Array.isArray(q.drain_waiting) ? q.drain_waiting.filter((w) => w?.item_id && w?.step) : []
  if (waiting.length > 0 && Number.isFinite(deadline)) {
    const count = `${waiting.length} running step${waiting.length === 1 ? '' : 's'}`
    const names = waiting.map((w) => `${w.item_id} ${w.step}`).join(', ')
    return `${q.target} deploy ${batch} · waiting for ${count} (${names}) · goes ahead by ${hhmm(deadline)} at the latest`
  }
  const since = msOf(q.deploying_since)
  if (!Number.isFinite(since)) return null
  const eta = msOf(q.live_eta)
  return `${q.target} deploy ${batch} · deploying since ${hhmm(since)}${Number.isFinite(eta) ? ` · live about ${hhmm(eta)}` : ''}`
}

export function deployQueueLabel(item, now = Date.now()) {
  const q = item?.deploy_queue
  if (!q) return null
  const stage = stageLabel(q, now)
  if (stage) return stage
  if (q.status !== 'queued') return null
  if (q.batch_status !== 'open') return `riding the ${q.target} deploy${q.tag ? ` ${q.tag}` : ''}`
  const closes = new Date(q.window_closes_at)
  if (Number.isNaN(closes.getTime())) return `waiting for next ${q.target} deploy`
  return `waiting for next ${q.target} deploy · window closes ${pad(closes.getHours())}:${pad(closes.getMinutes())}`
}
