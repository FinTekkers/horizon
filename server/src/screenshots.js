// HZ-509: the screenshots the owner reviews at Accept the code, and their
// per-screen approvals. The shots come from the item's latest publish
// (forRepo(repo).artifacts.readArtifacts: results.json plus its files); only
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
import { SCREENSHOT_DIR } from './backends/artifact.js'
import { forRepo } from './backends/index.js'

// The path-parameter shape of a screen name; anything else cannot be listed.
export const SCREEN_RE = /^[A-Za-z0-9._-]{1,100}$/

// HO-892: a screen name the image route serves — SCREEN_RE (so never a `/`)
// and no `..` anywhere, so no name can read as a path step. The farm's runner
// never makes such a name (farm/screenshot_runner.py png_name keeps only
// [A-Za-z0-9_-]), and listedShots drops one, so the panel never lists a shot
// the route refuses.
export const isScreenName = (name) => typeof name === 'string' && SCREEN_RE.test(name) && !name.includes('..')

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
    if (shot.status === 'same' || seen.has(shot.name) || !isScreenName(shot.name)) continue
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

// HO-852: pure — every shot of a publish, `same` ones too (listedShots drops
// them), sorted by name, for Automated review to compare against the frozen
// design canvas. The runner names a shot <screen>--<viewport>--<theme>
// (farm/screenshot_runner.py png_name), so the viewport is its second part.
// `path` is where its PNG sits in the publish, or null when it has none (a
// removed shot, or one whose capture failed).
export function allShots(snapshot) {
  if (!snapshot?.results) return []
  const seen = new Set()
  const shots = []
  for (const shot of snapshot.results.shots) {
    if (seen.has(shot.name)) continue
    seen.add(shot.name)
    const [screen, viewport = null, theme = null] = shot.name.split('--')
    const path = shot.status !== 'removed' && snapshot.files?.get(shotPath(shot.name)) ? shotPath(shot.name) : null
    shots.push({ name: shot.name, screen, viewport, theme, status: shot.status, path })
  }
  return shots.sort((a, b) => a.name.localeCompare(b.name))
}

export const REVIEW_SHOTS_LABEL = 'Screenshots from implement'

// HO-852: the prior-artifact entry Automated review gets beside the frozen
// canvas — every shot of the item's latest publish, which only Implement
// makes, named by its commit. It reads only: nothing is approved or promoted
// (that stays at Accept the code). Never throws: a failed read, or no
// publish, is said in the entry, and the review still dispatches.
// { label, content, commit } — commit is null when no shots could be listed.
export async function reviewShotsInput(item) {
  let snapshot
  try {
    snapshot = item.repo ? await forRepo(item.repo).artifacts.readArtifacts(item) : null
  } catch (err) {
    const why = String(err?.message ?? err).slice(0, 300)
    return {
      label: REVIEW_SHOTS_LABEL,
      content: `The implement run's screenshots could not be read: ${why}. Mark every screen not checked.`,
      commit: null,
    }
  }
  const shots = allShots(snapshot)
  if (shots.length === 0) {
    return {
      label: REVIEW_SHOTS_LABEL,
      content: 'The implement run published no screenshots for this item. Mark every screen on the canvas not checked.',
      commit: null,
    }
  }
  const rows = shots.map(
    (shot) =>
      `| ${shot.screen} | ${shot.viewport ?? '-'} | ${shot.theme ?? '-'} | ${shot.status} | ${shot.path ? `\`${shot.path}\`` : 'no image'} |`,
  )
  return {
    label: REVIEW_SHOTS_LABEL,
    content: [
      `${shots.length} screenshot${shots.length === 1 ? '' : 's'} from the implement run's latest publish, commit \`${snapshot.commit}\`. Every viewport is listed, phone included, and every status, unchanged ones included.`,
      '',
      '| Screen | Viewport | Theme | Status | File |',
      '| --- | --- | --- | --- | --- |',
      ...rows,
    ].join('\n'),
    commit: snapshot.commit ?? null,
  }
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

// HZ-510: the screens approved for what they show now — the Set
// github.mergePr promotes into e2e-baseline at merge. Read from the item's
// latest publish, so a stale approval (the shot changed since) is not in it.
// Never throws: null when the approvals could not be read, which fails the
// promotion closed (logged, artifacts ref kept) and never the merge.
export async function mergeApprovals(item) {
  try {
    const snapshot = item.repo ? await forRepo(item.repo).artifacts.readArtifacts(item) : null
    return new Set(approvalState(item.id, listedShots(snapshot)).filter((shot) => shot.approved).map((shot) => shot.screen))
  } catch {
    return null
  }
}
