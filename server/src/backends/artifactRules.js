// HO-878: the pure screenshot rules both Artifact backends share — moved
// unchanged out of server/src/github.js, so the sl adapter
// (backends/slArtifacts.js) applies GitHub's exact rules without importing
// github.js, which owns the GitHub client. No I/O, no database, no client.

import { endIndex, itemKindOf } from '../../../domain/js/lifecycle.js'
import { SCREENSHOT_DIR } from './artifact.js'

// HZ-508: the statuses results.json may give a shot.
export const RESULT_STATUSES = new Set(['changed', 'new', 'removed', 'same'])

export function isScreenshotResults(doc) {
  return (
    doc !== null &&
    typeof doc === 'object' &&
    Array.isArray(doc.shots) &&
    doc.shots.every(
      (s) =>
        s !== null &&
        typeof s === 'object' &&
        typeof s.name === 'string' &&
        RESULT_STATUSES.has(s.status) &&
        (s.diffRatio == null || typeof s.diffRatio === 'number') &&
        (s.diff == null || typeof s.diff === 'string') &&
        (s.error == null || typeof s.error === 'string'),
    )
  )
}

// HZ-513: why a publish's item no longer needs it, or null to keep it. `row`
// is the item's work_item row ({ kind, cursor, abandoned_at, merged_at }), or
// undefined when there is none.
export function artifactPruneReason(row) {
  if (!row) return 'unknown item'
  if (row.abandoned_at) return 'abandoned'
  if (row.merged_at) return 'merged'
  let end
  try {
    end = endIndex(itemKindOf(row))
  } catch {
    return null // an unrecognised kind: keep rather than guess
  }
  return row.cursor >= end ? 'closed' : null
}

// HZ-510: the shot names promotion accepts.
export const SHOT_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/

// Pure: the tree entries promoting `approvals` from `results`. `artifactFiles`
// and `baselineFiles` are path → { sha } maps (baselineFiles null when there
// is no baseline yet). Returns { entries, skipped }: skipped names an approved
// changed/new shot whose image is missing from the publish — it keeps its
// prior baseline blob rather than failing every other shot's promotion.
export function promotionEntries(results, approvals, artifactFiles, baselineFiles) {
  const entries = []
  const skipped = []
  const seen = new Set()
  for (const shot of results.shots) {
    if (!approvals.has(shot.name) || seen.has(shot.name) || !SHOT_NAME_RE.test(shot.name)) continue
    seen.add(shot.name)
    const path = `${SCREENSHOT_DIR}/${shot.name}.png`
    if (shot.status === 'changed' || shot.status === 'new') {
      const blob = artifactFiles.get(path)?.sha
      if (blob) entries.push({ path, mode: '100644', type: 'blob', sha: blob })
      else skipped.push(shot.name)
    } else if (shot.status === 'removed' && baselineFiles?.has(path)) {
      entries.push({ path, mode: '100644', type: 'blob', sha: null })
    }
  }
  return { entries, skipped }
}
