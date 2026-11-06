// HZ-803: when a step run happened, as the owner reads it — "5 Nov 20:06 · 20 h
// ago". Pure — no I/O, no env — so ui/src/components/Tracker.jsx (step cards)
// and server/src/runTimeView.js (the artifact and output pages) show the same
// text. Stored values stay UTC; only the text is in the viewer's timezone.
//
// server/src/runTimeView.js embeds these functions' source in the pages via
// Function.prototype.toString(), so they must use no imports and no
// module-scope values: only each other and globals (Date, Intl, Math).

// A stored step_run time ("YYYY-MM-DD HH:MM:SS", UTC) or an ISO string as ms,
// or null when missing or unreadable.
export function parseStoredUtc(stored) {
  if (typeof stored !== 'string' || !stored) return null
  const iso = stored.indexOf('T') === -1 ? stored.replace(' ', 'T') + 'Z' : stored
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

// "5 Nov 20:06 · 20 h ago" in `timeZone` (the viewer's own when omitted); the
// year only when it isn't the current one. null when `stored` is missing.
export function runTimeText(stored, nowMs, timeZone) {
  const ms = parseStoredUtc(stored)
  if (ms === null) return null
  const parts = {}
  const fmt = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: timeZone,
  })
  fmt.formatToParts(new Date(ms)).forEach(function (p) {
    parts[p.type] = p.value
  })
  let nowYear = ''
  fmt.formatToParts(new Date(nowMs)).forEach(function (p) {
    if (p.type === 'year') nowYear = p.value
  })
  const absolute =
    parts.day + ' ' + parts.month + (parts.year !== nowYear ? ' ' + parts.year : '') + ' ' + parts.hour + ':' + parts.minute
  const mins = Math.floor((nowMs - ms) / 60000)
  const relative =
    mins < 1
      ? 'just now'
      : mins < 60
        ? mins + ' min ago'
        : mins < 24 * 60
          ? Math.floor(mins / 60) + ' h ago'
          : Math.floor(mins / (24 * 60)) + ' d ago'
  return absolute + ' · ' + relative
}
