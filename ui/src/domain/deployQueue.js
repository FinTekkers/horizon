// HZ-333: the line the board and the Tracker show for an item waiting in its
// deploy target's queue (the server's `deploy_queue` field), or null when it
// is not queued. The close time is the viewer's local HH:MM.
const pad = (n) => String(n).padStart(2, '0')

export function deployQueueLabel(item) {
  const q = item?.deploy_queue
  if (!q || q.status !== 'queued') return null
  if (q.batch_status !== 'open') return `riding the ${q.target} deploy${q.tag ? ` ${q.tag}` : ''}`
  const closes = new Date(q.window_closes_at)
  if (Number.isNaN(closes.getTime())) return `waiting for next ${q.target} deploy`
  return `waiting for next ${q.target} deploy · window closes ${pad(closes.getHours())}:${pad(closes.getMinutes())}`
}
