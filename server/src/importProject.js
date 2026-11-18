// HO-880: an owner imports every item of an old project into a new project on
// another backend. Called only by app.js's POST /api/project-imports, which
// refuses any non-owner before this runs.
//
//   - Open items get a new tracker record in the target repo through its
//     Tracker port (forRepo(repo).tracker, handed in by app.js as
//     `trackerFor`), recorded the way every filing call site records one
//     (store.recordFiled), and the copy keeps its source item's id.
//   - Closed and abandoned items are copied as history, with their event and
//     gate_decision rows. The Tracker port is never called for them.
//   - The source items become read-only (importedItem.js) the moment the
//     import freezes them, and stay listed in their own project.
//   - Each run writes one project_event (kind 'import') on the target.
//
// Guardrails held here: the source repo's backend, its items, their history
// and their tracker records are never written — the only writes are the
// item_import ledger, the copies and their history, and the project_event.
// No item's backend changes: a copy is a new item that takes its repo's
// backend on insert. A re-run, or a re-run after a crash, creates no second
// record or copy: the ledger's UNIQUE(source_item_id) inserts nothing twice,
// a filed row is skipped, and a 'filing' row finds the record it may already
// have created by the marker in its body before it creates one (spawn.js's
// item_spawn pattern).

import { db } from './db.js'
import * as store from './store.js'
import { UI_URL } from './config.js'
import { hasNoProject } from './membership.js'
import { hasGithubIssue } from './trackerRefs.js'
import { isAbandoned, isClosed, itemKindOf } from '../../domain/js/lifecycle.js'

// The marker in an open copy's record body: what findSplitIssue looks for
// before a re-run creates a second record.
export const importMarker = (sourceItemId, targetProjectId) => `<!-- horizon-imported-from: ${sourceItemId} project=${targetProjectId} -->`

// A closed copy's id: the target repo's prefix, H (history), then the source
// id — NBHHZ-12 for HZ-12 into prefix NB. Deterministic, and never a
// <prefix>-<n> a tracker can hand out.
export const closedCopyId = (targetPrefix, sourceItemId) => `${targetPrefix}H${sourceItemId}`

const selectProject = db.prepare('SELECT id, name FROM project WHERE id = ?')
const selectRepos = db.prepare('SELECT repo, prefix, backend FROM project_repo WHERE project_id = ? ORDER BY repo')
const selectItems = db.prepare('SELECT * FROM work_item WHERE project_id = ? ORDER BY id')
const selectItemBackends = db.prepare('SELECT DISTINCT backend FROM work_item WHERE project_id = ?')
const countItems = db.prepare('SELECT COUNT(*) AS n FROM work_item WHERE project_id = ?')
const selectOtherTarget = db.prepare('SELECT target_project_id FROM item_import WHERE source_project_id = ? AND target_project_id <> ? LIMIT 1')
const selectOtherSource = db.prepare('SELECT source_project_id FROM item_import WHERE target_project_id = ? AND source_project_id <> ? LIMIT 1')
const selectPairRow = db.prepare('SELECT 1 FROM item_import WHERE source_project_id = ? AND target_project_id = ? LIMIT 1')
const selectActiveRuns = db.prepare(`
  SELECT DISTINCT s.item_id FROM step_run s JOIN work_item w ON w.id = s.item_id
   WHERE w.project_id = ? AND s.status = 'active' ORDER BY s.item_id`)
const insertLedger = db.prepare(`
  INSERT OR IGNORE INTO item_import (source_item_id, source_project_id, target_project_id, closed, created_by)
  VALUES (?, ?, ?, ?, ?)`)
// Closed rows first: they never wait on the tracker.
const selectLedger = db.prepare(`
  SELECT * FROM item_import WHERE source_project_id = ? AND target_project_id = ? ORDER BY closed DESC, id`)
const selectItem = db.prepare('SELECT * FROM work_item WHERE id = ?')
const setFiling = db.prepare("UPDATE item_import SET status = 'filing', updated_at = datetime('now') WHERE id = ? AND status <> 'filed'")
const setRecordRef = db.prepare("UPDATE item_import SET target_record_ref = ?, updated_at = datetime('now') WHERE id = ?")
const setFiled = db.prepare(
  "UPDATE item_import SET status = 'filed', target_item_id = ?, updated_at = datetime('now') WHERE id = ? AND status <> 'filed'",
)
const linkCopy = db.prepare("UPDATE work_item SET source_item_id = ?, updated_at = datetime('now') WHERE id = ? AND source_item_id IS NULL")
const selectLinked = db.prepare('SELECT source_item_id FROM work_item WHERE id = ?')
const insertClosedCopy = db.prepare(`
  INSERT INTO work_item (
    id, title, priority, desc, metric, guardrails, issue, task_id, repo, project_id, cursor, kind, lane,
    autopilot_off, substeps_json, personas_json, scope_repos_json, backend, source_item_id,
    abandoned_at, abandoned_reason, abandoned_by, merged_at, pr_url, release_url, created_at
  ) VALUES (
    @id, @title, @priority, @desc, @metric, @guardrails, NULL, NULL, @repo, @projectId, @cursor, @kind, @lane,
    @autopilotOff, NULL, @personasJson, NULL, @backend, @sourceItemId,
    @abandonedAt, @abandonedReason, @abandonedBy, @mergedAt, @prUrl, @releaseUrl, @createdAt
  )`)
const copyEvents = db.prepare(`
  INSERT INTO event (item_id, who, text, color, initials, detail, verdict, created_at)
  SELECT ?, who, text, color, initials, detail, verdict, created_at FROM event WHERE item_id = ? ORDER BY id`)
const copyGateDecisions = db.prepare(`
  INSERT INTO gate_decision (item_id, step_index, decision, notes, decided_by, created_at)
  SELECT ?, step_index, decision, notes, decided_by, created_at FROM gate_decision WHERE item_id = ? ORDER BY id`)
const insertProjectEvent = db.prepare("INSERT INTO project_event (project_id, kind, old_value, new_value, who) VALUES (?, 'import', NULL, ?, ?)")

// Source projects with an import running in this process. One server process,
// so this is the whole lock: a second request for the same source waits for
// nothing and is refused.
const inProgress = new Set()

const refusal = (error, status, extra = {}) => ({ error, status, ...extra })
const closedHistory = (item) => isClosed(item) || isAbandoned(item)

// SQLite's 'YYYY-MM-DD HH:MM:SS' (UTC) less an hour of clock-skew slack, as
// ISO — findSplitIssue's paging bound, as in spawn.js.
function sinceIso(createdAt) {
  const ms = Date.parse(`${String(createdAt).replace(' ', 'T')}Z`)
  return new Date((Number.isNaN(ms) ? Date.now() : ms) - 60 * 60 * 1000).toISOString()
}

// Everything checked before anything is written. { source, target, repo,
// items } or a refusal.
function checkImport({ sourceProjectId, targetProjectId, targetRepo }) {
  const source = selectProject.get(sourceProjectId)
  const target = selectProject.get(targetProjectId)
  if (!source || !target) return refusal('not_found', 404)
  if (source.id === target.id || hasNoProject(db, source.id) || hasNoProject(db, target.id)) return refusal('bad_projects', 400)
  const repos = selectRepos.all(target.id)
  const repo = targetRepo == null ? (repos.length === 1 ? repos[0] : null) : (repos.find((r) => r.repo.toLowerCase() === targetRepo.toLowerCase()) ?? null)
  if (!repo) return refusal('target_repo_required', 400)
  // Never the same backend: an import moves items across backends, and
  // never switches a repo's or an item's backend in place.
  const sourceBackends = new Set([...selectItemBackends.all(source.id), ...selectRepos.all(source.id)].map((row) => row.backend))
  if (sourceBackends.has(repo.backend)) return refusal('same_backend', 400)
  // A source goes to one target; a target takes one source, and only while
  // it is new — empty, unless it is this import's own re-run.
  if (selectOtherTarget.get(source.id, target.id)) return refusal('already_imported', 409)
  if (selectOtherSource.get(target.id, source.id)) return refusal('target_not_new', 409)
  if (!selectPairRow.get(source.id, target.id) && countItems.get(target.id).n > 0) return refusal('target_not_new', 409)
  return { source, target, repo }
}

// Freezes every source item in one transaction, after checking none is
// running: no await between the check and the freeze, so the orchestrator
// cannot dispatch in between. From here on every source item is read-only.
function freeze(sourceId, targetId, who) {
  return db.transaction(() => {
    const running = new Set(selectActiveRuns.all(sourceId).map((row) => row.item_id))
    const items = selectItems.all(sourceId)
    for (const run of store.listRunningGateActions()) if (items.some((item) => item.id === run.itemId)) running.add(run.itemId)
    if (running.size > 0) return refusal('source_has_running_jobs', 409, { items: [...running].sort() })
    for (const item of items) insertLedger.run(item.id, sourceId, targetId, closedHistory(item) ? 1 : 0, who)
    return { ok: true }
  })()
}

// The closed or abandoned item as history in the target: one transaction for
// the copy, its event and gate_decision rows, and its ledger row.
function copyClosed(row, item, repo, targetId) {
  const id = closedCopyId(repo.prefix, item.id)
  db.transaction(() => {
    insertClosedCopy.run({
      id,
      title: item.title,
      priority: item.priority,
      desc: item.desc,
      metric: item.metric,
      guardrails: item.guardrails,
      repo: repo.repo,
      projectId: targetId,
      cursor: item.cursor,
      kind: itemKindOf(item),
      lane: item.lane ?? null,
      autopilotOff: item.autopilot_off ? 1 : 0,
      personasJson: item.personas_json ?? null,
      backend: repo.backend,
      sourceItemId: item.id,
      abandonedAt: item.abandoned_at ?? null,
      abandonedReason: item.abandoned_reason ?? null,
      abandonedBy: item.abandoned_by ?? null,
      mergedAt: item.merged_at ?? null,
      prUrl: item.pr_url ?? null,
      releaseUrl: item.release_url ?? null,
      createdAt: item.created_at,
    })
    copyEvents.run(id, item.id)
    copyGateDecisions.run(id, item.id)
    store.addEvent(id, { who: 'Horizon', text: `imported from ${item.id} as history`, color: '#5E4380', initials: 'HZ' })
    setFiled.run(id, row.id)
  })()
}

// The record's body after its Outcome / Success metric / Guardrails: a
// back-link and the marker, under their own heading so parseIssueBody keeps
// both out of the copy's guardrails.
function importBodySuffix(item, targetId) {
  const issueRef = hasGithubIssue(item) ? ` · \`${item.repo}#${item.issue}\`` : ''
  return ['## Imported from', `[${item.id}](${UI_URL}/${item.id.toLowerCase()})${issueRef}`, '', importMarker(item.id, targetId)].join('\n')
}

// One open item: a tracker record in the target repo (found by its marker
// first, so a crash between the create and the record never files a second),
// then the copy and its ledger row in one transaction.
async function fileOpen(row, item, repo, targetId, trackerFor) {
  setFiling.run(row.id)
  const tracker = trackerFor(repo.repo)
  let record = await tracker.findSplitIssue(repo.repo, importMarker(item.id, targetId), sinceIso(row.created_at))
  if (!record) {
    record = await tracker.createIssue(repo.repo, {
      title: item.title,
      outcome: item.desc,
      metric: item.metric,
      guardrails: item.guardrails,
      priority: item.priority,
      kind: itemKindOf(item),
      lane: item.lane ?? null,
      autopilotOff: !!item.autopilot_off,
      bodySuffix: importBodySuffix(item, targetId),
    })
  }
  setRecordRef.run(String(record.number), row.id)
  const copyId = db.transaction(() => {
    const copy = store.recordFiled(record, repo.repo)
    if (!copy) throw new Error(`${repo.repo} record ${record.number} did not record as an item`)
    linkCopy.run(item.id, copy.id)
    if (selectLinked.get(copy.id)?.source_item_id !== item.id) throw new Error(`${copy.id} is already a copy of another item`)
    setFiled.run(copy.id, row.id)
    return copy.id
  })()
  store.addEvent(copyId, { who: 'Horizon', text: `imported from ${item.id}`, color: '#5E4380', initials: 'HZ' })
}

// Runs one import. { ok, sourceProjectId, targetProjectId, targetRepo, open,
// closed, skipped, eventId } — open and closed count the copies this run
// made, skipped the ones an earlier run made — or a refusal { error, status }.
// A tracker failure stops the run as { error: 'tracker_failed', status: 502,
// filed, eventId }: what was filed stays filed, and a re-run finishes the rest.
export async function importProject({ sourceProjectId, targetProjectId, targetRepo = null, who, trackerFor }) {
  const checked = checkImport({ sourceProjectId, targetProjectId, targetRepo })
  if (checked.error) return checked
  const { source, target, repo } = checked
  if (inProgress.has(source.id)) return refusal('import_in_progress', 409)
  inProgress.add(source.id)
  try {
    const frozen = freeze(source.id, target.id, who)
    if (frozen.error) return frozen
    const counts = { open: 0, closed: 0, skipped: 0 }
    let failure = null
    for (const row of selectLedger.all(source.id, target.id)) {
      if (row.status === 'filed') {
        counts.skipped++
        continue
      }
      const item = selectItem.get(row.source_item_id)
      if (row.closed) {
        copyClosed(row, item, repo, target.id)
        counts.closed++
        continue
      }
      try {
        await fileOpen(row, item, repo, target.id, trackerFor)
        counts.open++
      } catch (err) {
        failure = { item: item.id, message: String(err?.message || err) }
        break
      }
    }
    const summary = { source: source.id, target: target.id, open: counts.open, closed: counts.closed, skipped: counts.skipped }
    if (failure) summary.error = 'tracker_failed'
    const eventId = Number(insertProjectEvent.run(target.id, JSON.stringify(summary), who).lastInsertRowid)
    store.notifyChange()
    if (failure) return refusal('tracker_failed', 502, { item: failure.item, detail: failure.message, filed: counts.open + counts.closed, eventId })
    return { ok: true, sourceProjectId: source.id, targetProjectId: target.id, targetRepo: repo.repo, ...counts, eventId }
  } finally {
    inProgress.delete(source.id)
  }
}
