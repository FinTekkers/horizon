// HZ-509: the screenshots the owner reviews at Accept the code, and their
// per-screen approvals. The shots come from the item's latest publish
// (github.fetchScreenshotSnapshot: results.json plus the commit's tree); only
// the changed, new and removed ones are listed. Every image is named by a blob
// sha read from that tree, at a path built from results.json's own names — a
// request only ever picks one of these listed rows by its exact screen name,
// so request input never becomes a ref or a path.
//
// An approval stores the fingerprint of what the owner saw (blob shas). It
// counts only while that still equals the current fingerprint, so a later
// publish that changes a shot resets its approval, and an unchanged shot keeps
// it, with nothing to fire on publish. Approving never touches the gate.

import { db } from './db.js'
import * as store from './store.js'
import { SCREENSHOT_DIR } from './github.js'

// The path-parameter shape of a screen name; anything else cannot be listed.
export const SCREEN_RE = /^[A-Za-z0-9._-]{1,100}$/

// Images the panel shows, in the order it shows them.
export const IMAGE_KINDS = ['baseline', 'new', 'diff']

const shotPath = (name) => `${SCREENSHOT_DIR}/${name}.png`
const diffPath = (name) => `${SCREENSHOT_DIR}/diff/${name}.png`

// Pure: what the owner approves for one shot. A changed shot includes the
// baseline it was compared with, so a moved baseline is a new comparison.
export function fingerprintOf(shot) {
  const sha = (kind) => shot.images[kind]?.sha ?? '-'
  if (shot.status === 'new') return `new:${sha('new')}`
  if (shot.status === 'removed') return `removed:${sha('baseline')}`
  return `new:${sha('new')}|base:${sha('baseline')}`
}

// Pure: the rows to show, sorted by name — one per changed, new or removed
// shot. `images` maps each available kind to its tree entry ({sha, size}).
export function listedShots(snapshot) {
  if (!snapshot?.results) return []
  const { files, baselineFiles } = snapshot
  const seen = new Set()
  const shots = []
  for (const shot of snapshot.results.shots) {
    if (shot.status === 'same' || seen.has(shot.name)) continue
    seen.add(shot.name)
    const images = {}
    if (shot.status !== 'new' && baselineFiles?.get(shotPath(shot.name))) images.baseline = baselineFiles.get(shotPath(shot.name))
    if (shot.status !== 'removed' && files?.get(shotPath(shot.name))) images.new = files.get(shotPath(shot.name))
    // Only the diff at the expected path: the stored field picks nothing else.
    if (shot.status === 'changed' && shot.diff === diffPath(shot.name) && files?.get(diffPath(shot.name))) {
      images.diff = files.get(diffPath(shot.name))
    }
    const row = { screen: shot.name, status: shot.status, diffRatio: shot.diffRatio ?? null, error: shot.error ?? null, images }
    shots.push({ ...row, fingerprint: fingerprintOf(row) })
  }
  return shots.sort((a, b) => a.screen.localeCompare(b.screen))
}

const approvalsOf = (itemId) =>
  db.prepare('SELECT screen, fingerprint, actor, approved_at FROM screenshot_approval WHERE item_id = ?').all(itemId)

// The listed shots as the API sends them: no blob shas, plus whether each is
// approved for what it shows now.
export function approvalState(itemId, shots) {
  const stored = new Map(approvalsOf(itemId).map((row) => [row.screen, row]))
  return shots.map((shot) => {
    const row = stored.get(shot.screen)
    const approved = !!row && row.fingerprint === shot.fingerprint
    return {
      screen: shot.screen,
      status: shot.status,
      diffRatio: shot.diffRatio,
      error: shot.error,
      images: IMAGE_KINDS.filter((kind) => Object.hasOwn(shot.images, kind)),
      approved,
      approvedBy: approved ? row.actor : null,
      approvedAt: approved ? row.approved_at : null,
    }
  })
}

const upsert = db.prepare(
  `INSERT INTO screenshot_approval (item_id, screen, fingerprint, actor) VALUES (?, ?, ?, ?)
   ON CONFLICT (item_id, screen) DO UPDATE SET fingerprint = excluded.fingerprint, actor = excluded.actor, approved_at = datetime('now')`,
)

// Records the current fingerprint of each given (listed) shot, in one
// transaction, and notes it in the item's activity.
export function recordApprovals(itemId, shots, actor) {
  if (shots.length === 0) return
  db.transaction(() => {
    for (const shot of shots) upsert.run(itemId, shot.screen, shot.fingerprint, actor)
  })()
  store.addEvent(itemId, {
    who: actor,
    text: `approved screenshots: ${shots.map((shot) => shot.screen).join(', ')}`,
    color: '#5E4380',
    initials: 'YOU',
  })
  store.notifyChange()
}
