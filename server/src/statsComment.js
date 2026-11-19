// HZ-921: the Effort & cost stats comment on an item's tracker record, for
// offline analysis from the GitHub API. One summary line, then STATS_MARKER
// and one fenced `json` block holding statsBlock(itemStats(id)) — the same
// object the item page shows — then Horizon's footer, so comment ingestion
// skips it.
//
// Posted once an item is closed or abandoned (app.js, fire-and-forget after
// the close: a failure is logged and an event added, never thrown into the
// close) and by server/scripts/backfill-item-stats.mjs. Each tracker adapter's
// upsertStatsComment finds the comment by its marker, so a re-run edits it or
// leaves it alone and never adds a second one.

import { db } from './db.js'
import * as store from './store.js'
import { forItem } from './backends/index.js'
import { UI_URL } from './config.js'
import { HORIZON_FOOTER, STATS_MARKER } from './trackerText.js'
import { hasTrackerRef, trackerRefText } from './trackerRefs.js'
import { STATS_KEYS, itemStats } from './itemStats.js'
import { isAbandoned, isClosed } from '../../domain/js/lifecycle.js'
import { statsSummaryLine } from '../../domain/js/itemStats.js'

export { STATS_MARKER }
export {
  formatClarification,
  formatCost,
  formatDuration,
  formatTokens,
  formatTurns,
  statsSummaryLine,
} from '../../domain/js/itemStats.js'

// A deep copy of `stats` holding only STATS_KEYS, at any depth: the comment
// can never carry a field nobody allowlisted.
export function statsBlock(stats) {
  if (Array.isArray(stats)) return stats.map(statsBlock)
  if (stats === null || typeof stats !== 'object') return stats
  return Object.fromEntries(
    Object.entries(stats)
      .filter(([key]) => STATS_KEYS.has(key))
      .map(([key, value]) => [key, statsBlock(value)]),
  )
}

export function renderStatsComment(stats) {
  return [
    `**Effort & cost:** ${statsSummaryLine(stats)}`,
    '',
    STATS_MARKER,
    '```json',
    JSON.stringify(statsBlock(stats), null, 2),
    '```',
    '',
    `_[open in Horizon](${UI_URL}/${stats.item.toLowerCase()}) · ${HORIZON_FOOTER}`,
  ].join('\n')
}

// ---- posting ----

// Posts or updates `item`'s stats comment. Resolves the adapter's result
// ('posted', 'updated', 'unchanged', or sl's 'kept'), 'skipped' for an item
// with no tracker record or not yet closed or abandoned, or 'failed' after
// logging it and adding an event. Never rejects.
export async function postItemStats(item, log) {
  try {
    if (!item?.repo || !hasTrackerRef(item) || !(isClosed(item) || isAbandoned(item))) return 'skipped'
    const stats = itemStats(item.id)
    if (!stats) return 'skipped'
    const result = await forItem(item).tracker.upsertStatsComment(item, renderStatsComment(stats))
    if (result === 'kept') log?.info?.(`${item.id}: stats comment exists; sl cannot edit it, so the first one stands`)
    return result
  } catch (err) {
    log?.warn?.(`${item?.id}: could not post the stats comment: ${err.message}`)
    try {
      store.addEvent(item.id, {
        who: 'Horizon',
        text: `could not post the effort & cost stats to ${trackerRefText(item)}: ${err.message}`,
        color: '#9C333E',
        initials: 'HZ',
      })
    } catch {
      // the log line above stands
    }
    return 'failed'
  }
}

// The close and abandon routes' posts, still in flight. Not awaited there;
// settleStatsPosts lets a test wait for them, so no stub answers after it ends.
const inFlight = new Set()

export function queueItemStats(item, log) {
  const post = postItemStats(item, log).finally(() => inFlight.delete(post))
  inFlight.add(post)
  return post
}

export function settleStatsPosts() {
  return Promise.allSettled([...inFlight])
}

// ---- backfill ----

const selectBackfillIds = db.prepare(`
  SELECT id FROM work_item
   WHERE (@itemId IS NULL OR id = @itemId) AND (@projectId IS NULL OR project_id = @projectId)
   ORDER BY created_at, id`)

// The closed and abandoned items with a tracker record, optionally one item or
// one project's; each gets postItemStats (or, with dryRun, its summary line and
// no request). Resolves [{ id, result, line }].
export async function backfillItemStats({ dryRun = false, itemId = null, projectId = null, log } = {}) {
  const results = []
  for (const { id } of selectBackfillIds.all({ itemId, projectId })) {
    const item = store.getItem(id)
    if (!item?.repo || !hasTrackerRef(item) || !(isClosed(item) || isAbandoned(item))) continue
    const stats = itemStats(id)
    if (!stats) continue
    const line = statsSummaryLine(stats)
    results.push({ id, result: dryRun ? 'dry-run' : await postItemStats(item, log), line })
  }
  return results
}
