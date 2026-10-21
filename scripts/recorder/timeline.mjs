// Turns what the recorder saw into timeline.json entries: one per step run
// (plus the optional before and after cards), each with the frames the video
// shows and for how long.
//
// Steps are grouped by the item's cursor, not by pixel hash: the live board
// has ticking timers, so two heartbeat frames almost never hash equal. A step
// that really took longer than IDLE_CARD_MS becomes a single caption card
// ("Build & checks: 47 min → 6 s"); a shorter one shows its distinct frames.

export const FRAME_SECONDS = 1.5
export const CARD_SECONDS = 6
export const SITE_SECONDS = 3
export const MAX_STEP_FRAMES = 3
export const IDLE_CARD_MS = 2 * 60 * 1000
export const MAX_VIDEO_SECONDS = 55

// steps: [{ step, realStart, realEnd, frames: [{ file, hash }] }] with times in
// ms; before/after: { file, at, url } or null. Card entries come back with a
// `from` frame; main.mjs renders their `frame` PNG from it and the caption.
export function buildTimeline({ steps, before = null, after = null }) {
  const entries = []
  if (before) entries.push(siteEntry('before', before))
  let cardNo = 0
  for (const s of steps) {
    const realMs = Math.max(0, s.realEnd - s.realStart)
    const base = { step: s.step, realStart: iso(s.realStart), realEnd: iso(s.realEnd) }
    const last = s.frames[s.frames.length - 1]
    if (realMs > IDLE_CARD_MS && last) {
      cardNo += 1
      const frame = `frames/card-${String(cardNo).padStart(4, '0')}.png`
      entries.push({ ...base, kind: 'card', frame, from: last.file, realMs, shown: [{ frame, seconds: CARD_SECONDS }] })
    } else {
      const picked = pickFrames(s.frames)
      entries.push({
        ...base,
        kind: 'step',
        frame: last?.file ?? null,
        frames: picked.map((f) => f.file),
        shown: picked.map((f) => ({ frame: f.file, seconds: FRAME_SECONDS })),
      })
    }
  }
  if (after) entries.push(siteEntry('after', after))
  fitToCap(entries)
  for (const e of entries) {
    e.secondsOnScreen = round1(e.shown.reduce((sum, s) => sum + s.seconds, 0))
    if (e.kind === 'card') {
      e.caption = formatGap(e.step, e.realMs, e.secondsOnScreen)
      delete e.realMs
    }
  }
  return entries
}

function siteEntry(kind, shot) {
  const at = iso(shot.at)
  const title = kind === 'before' ? 'Before' : 'After'
  return {
    step: title,
    kind,
    frame: shot.file,
    caption: `${title}: ${shot.url}`,
    realStart: at,
    realEnd: at,
    shown: [{ frame: `frames/card-${kind}.png`, seconds: SITE_SECONDS }],
  }
}

// Consecutive identical frames (same hash) count once; more than
// MAX_STEP_FRAMES distinct ones keep the first, the middle and the last.
export function pickFrames(frames) {
  const distinct = frames.filter((f, i) => i === 0 || f.hash !== frames[i - 1].hash)
  if (distinct.length <= MAX_STEP_FRAMES) return distinct
  return [distinct[0], distinct[Math.floor(distinct.length / 2)], distinct[distinct.length - 1]]
}

// Scales every on-screen duration down so the video stays under
// MAX_VIDEO_SECONDS. Captions are written afterwards, so they show the real
// seconds a card is on screen.
function fitToCap(entries) {
  const total = entries.reduce((sum, e) => sum + e.shown.reduce((s, x) => s + x.seconds, 0), 0)
  if (total <= MAX_VIDEO_SECONDS) return
  const factor = MAX_VIDEO_SECONDS / total
  for (const e of entries) for (const s of e.shown) s.seconds = Math.max(0.1, Math.floor(s.seconds * factor * 10) / 10)
}

export function formatGap(label, realMs, screenS) {
  return `${label}: ${formatDuration(realMs)} → ${formatSeconds(screenS)} s`
}

export function formatDuration(ms) {
  const totalMin = Math.round(ms / 60000)
  if (ms < 60000) return `${Math.round(ms / 1000)} s`
  if (totalMin < 60) return `${totalMin} min`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

function formatSeconds(s) {
  return Number.isInteger(s) ? String(s) : s.toFixed(1)
}

function round1(n) {
  return Math.round(n * 10) / 10
}

function iso(ms) {
  return new Date(ms).toISOString()
}
