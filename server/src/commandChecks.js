// HO-845: the per-command checks of an owner's one-command patch (HO-843).
// Before the patched command `k` may get its PIN Approve card, it passes three
// stages, in order: contract audit, preflight, rehearsal. Each stage is one
// command_check row bound to k's 0-based index and the sha256 of its text; a
// stage's row is written only once the stage before it passed for the same
// hash, so a later stage never starts early, and no pass for another command,
// another text or an earlier patch (superseded) ever counts.
//
// Data only: this module reads and writes command_check and nothing else. The
// orchestrator drives the stages (dispatch, timers, the return to Run plan);
// store.js asks commandCheckGate() at Approve the run and shows
// commandChecksView(). It never imports either, so neither import is circular.
//
// What a row may hold is allowlisted here: a reason id from
// domain/runPlanContract.json `commandCheckReasons`, and a summary of names,
// access flags and reason ids (cleanSummary). Never a value, a file's contents
// or free text from the farm.

import { db } from './db.js'
import { COMMAND_CHECK_REASONS, COMMAND_CHECK_STAGES, REHEARSAL_REASONS, literalSecrets } from '../../domain/js/runPlan.js'

export { COMMAND_CHECK_STAGES, COMMAND_CHECK_REASONS }

// How long each stage may stay pending before it fails as timed out — the
// farm's own cap plus room to start: the audit is a static scan, preflight has
// 90 s (farm/preflight.py CAP_S), and a rehearsal pulls (600 s) then runs.
export const COMMAND_STAGE_TIMEOUT_MS = Object.freeze({ audit: 2 * 60_000, preflight: 5 * 60_000, rehearsal: 20 * 60_000 })

const HASH_HEX = /^[0-9a-f]{64}$/
const STATUSES = new Set(['pass', 'fail', 'error'])
// A gap's kind: run_plan_requires.Gap and farm/preflight.py unmet kinds.
const GAP_KINDS = new Set(['container', 'cwd', 'deploy', 'env', 'file', 'jobs', 'login_env', 'path', 'plan', 'precondition', 'probe', 'runner', 'run_user', 'service', 'tool'])
const NAME = /^[A-Za-z0-9._@+/:~-]{1,200}$/
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/
const PATH = /^[A-Za-z0-9._@+/~-]{1,300}$/
// A rehearsal finding's label is the farm's own ("dry run", "proof command 2
// (metric line 1)", "precondition check 1"), never a command's text.
const WHAT = /^[a-z_]+(?: [a-z_]+)*(?: \d+)?(?: \(metric line \d+\))?$/
const LIST_MAX = 50

const selectRow = db.prepare('SELECT * FROM command_check WHERE id = ?')
const selectLive = db.prepare('SELECT * FROM command_check WHERE item_id = ? AND command_index = ? AND command_hash = ? AND superseded = 0 ORDER BY id')

export function commandCheckRow(checkId) {
  return selectRow.get(checkId) ?? null
}

// The live rows of k at `hash`, one per stage, keyed by stage.
function liveStages(itemId, index, hash) {
  const byStage = {}
  for (const row of selectLive.all(itemId, index, hash)) byStage[row.stage] = row
  return byStage
}

// HO-845: a new owner patch replaces whatever was being checked: every live
// row of the item is superseded, and a pending one fails as replaced, so a
// late farm reply for it is stale and no pass of it is ever reused.
export function supersedeCommandChecks(itemId) {
  db.prepare(
    "UPDATE command_check SET status = 'fail', reason = 'command_hash_changed', ended_at = datetime('now') WHERE item_id = ? AND status = 'pending' AND superseded = 0",
  ).run(itemId)
  db.prepare('UPDATE command_check SET superseded = 1 WHERE item_id = ? AND superseded = 0').run(itemId)
}

// The first stage of k at `hash` — { checkId, stage: 'audit' } — or
// { error: 'already_started' } when this patch's checks already have rows.
export function startCommandChecks(itemId, { index, hash }) {
  if (!Number.isInteger(index) || index < 0 || typeof hash !== 'string' || !HASH_HEX.test(hash)) return { error: 'bad_command' }
  if (selectLive.all(itemId, index, hash).length) return { error: 'already_started' }
  const checkId = db
    .prepare("INSERT INTO command_check (item_id, command_index, command_hash, stage, status) VALUES (?, ?, ?, 'audit', 'pending')")
    .run(itemId, index, hash).lastInsertRowid
  return { checkId: Number(checkId), stage: COMMAND_CHECK_STAGES[0] }
}

// What a farm summary may say, normalized; null when it holds anything else —
// an unknown key, a value outside its pattern, or anything shaped like a
// literal secret. Names, access flags, reason ids and exit codes only.
export function cleanSummary(summary) {
  if (summary == null) return {}
  if (typeof summary !== 'object' || Array.isArray(summary)) return null
  const out = {}
  for (const [key, list] of Object.entries(summary)) {
    if (!Array.isArray(list) || list.length > LIST_MAX) return null
    const entries = []
    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
      const keys = Object.keys(entry).sort().join(',')
      if (key === 'gaps' && keys === 'kind,name' && GAP_KINDS.has(entry.kind) && NAME.test(entry.name)) {
        entries.push({ kind: entry.kind, name: entry.name })
      } else if (key === 'env' && keys === 'name,set' && ENV_NAME.test(entry.name) && typeof entry.set === 'boolean') {
        entries.push({ name: entry.name, set: entry.set })
      } else if (key === 'files' && keys === 'path,readable' && PATH.test(entry.path) && typeof entry.readable === 'boolean') {
        entries.push({ path: entry.path, readable: entry.readable })
      } else if (
        key === 'failures' &&
        keys === 'exit,reason,what' &&
        WHAT.test(entry.what) &&
        REHEARSAL_REASONS.includes(entry.reason) &&
        (entry.exit === null || Number.isInteger(entry.exit))
      ) {
        entries.push({ what: entry.what, reason: entry.reason, exit: entry.exit })
      } else {
        return null
      }
    }
    out[key] = entries
  }
  return literalSecrets(JSON.stringify(out)).length ? null : out
}

// HO-845: the farm's (or the demo mock's) result for one stage row. `status`
// 'error' is stored as a fail, never a pass. Refused, writing nothing:
// not_found; stale_check — the row is not pending, is superseded, is another
// stage, carries another hash, or an earlier stage has no pass for it;
// bad_body — a reason or summary outside the allowlist. On a pass `next` is
// the stage to start (null after the rehearsal); on a fail it is null.
export function recordStageResult(checkId, { stage, status, commandHash, reason = null, summary = null } = {}) {
  const row = commandCheckRow(checkId)
  if (!row) return { error: 'not_found' }
  if (!STATUSES.has(status) || (reason != null && !COMMAND_CHECK_REASONS.includes(reason))) return { error: 'bad_body' }
  const clean = cleanSummary(summary)
  if (clean === null) return { error: 'bad_body' }
  if (row.status !== 'pending' || row.superseded || stage !== row.stage || commandHash !== row.command_hash) return { error: 'stale_check' }
  const order = COMMAND_CHECK_STAGES.indexOf(row.stage)
  const live = liveStages(row.item_id, row.command_index, row.command_hash)
  if (COMMAND_CHECK_STAGES.slice(0, order).some((earlier) => live[earlier]?.status !== 'pass')) return { error: 'stale_check' }
  const passed = status === 'pass'
  const stored = passed ? null : (reason ?? (status === 'error' ? 'command_check_error' : 'command_check_failed'))
  db.prepare("UPDATE command_check SET status = ?, reason = ?, summary_json = ?, ended_at = datetime('now') WHERE id = ? AND status = 'pending'").run(
    passed ? 'pass' : 'fail',
    stored,
    JSON.stringify(clean),
    checkId,
  )
  return { ok: true, row: commandCheckRow(checkId), passed, next: passed ? (COMMAND_CHECK_STAGES[order + 1] ?? null) : null }
}

// The next stage's row, once the one before it passed — { checkId, stage }.
// Refused (stale_check) unless every earlier stage of the same hash passed.
export function startNextStage(checkId) {
  const row = commandCheckRow(checkId)
  if (!row || row.status !== 'pass' || row.superseded) return { error: 'stale_check' }
  const stage = COMMAND_CHECK_STAGES[COMMAND_CHECK_STAGES.indexOf(row.stage) + 1]
  if (!stage) return { error: 'stale_check' }
  const live = liveStages(row.item_id, row.command_index, row.command_hash)
  if (live[stage] || COMMAND_CHECK_STAGES.slice(0, COMMAND_CHECK_STAGES.indexOf(stage)).some((s) => live[s]?.status !== 'pass')) return { error: 'stale_check' }
  const next = db
    .prepare("INSERT INTO command_check (item_id, command_index, command_hash, stage, status) VALUES (?, ?, ?, ?, 'pending')")
    .run(row.item_id, row.command_index, row.command_hash, stage).lastInsertRowid
  return { checkId: Number(next), stage }
}

// A stage that timed out, errored or could not run: a fail with `reason`,
// never a pass. { ok, row } or { error: 'stale_check' } when it already ended.
export function failStage(checkId, reason) {
  const code = COMMAND_CHECK_REASONS.includes(reason) ? reason : 'command_check_error'
  const res = db
    .prepare("UPDATE command_check SET status = 'fail', reason = ?, ended_at = datetime('now') WHERE id = ? AND status = 'pending'")
    .run(code, checkId)
  if (res.changes === 0) return { error: 'stale_check' }
  return { ok: true, row: commandCheckRow(checkId) }
}

// THE gate for k: { ok } only when all three stages passed for k's current
// hash; else command_check_failed (with the failed stage and its reason) or
// command_checks_incomplete. Approve the run asks it after the PIN proof.
export function commandCheckGate(itemId, index, hash) {
  const live = liveStages(itemId, index, hash)
  const failed = COMMAND_CHECK_STAGES.find((stage) => live[stage]?.status === 'fail')
  if (failed) return { error: 'command_check_failed', failedStage: failed, reason: live[failed].reason }
  if (COMMAND_CHECK_STAGES.every((stage) => live[stage]?.status === 'pass')) return { ok: true }
  return { error: 'command_checks_incomplete' }
}

// Pending rows whose stage ran past its timeout at `nowMs`.
export function staleChecks(nowMs) {
  return db
    .prepare("SELECT * FROM command_check WHERE status = 'pending'")
    .all()
    .filter((row) => Date.parse(`${row.started_at.replace(' ', 'T')}Z`) + COMMAND_STAGE_TIMEOUT_MS[row.stage] <= nowMs)
}

// Every pending row, oldest first (the orchestrator re-arms their timers at boot).
export function pendingChecks() {
  return db.prepare("SELECT * FROM command_check WHERE status = 'pending' ORDER BY id").all()
}

const parseSummary = (json) => {
  try {
    return JSON.parse(json ?? '{}') ?? {}
  } catch {
    return {}
  }
}

// One line per finding, names and reason ids only, for the card.
function findingsOf(row) {
  const summary = parseSummary(row.summary_json)
  return [
    ...(summary.gaps ?? []).map((g) => `${g.kind} ${g.name}`),
    ...(summary.env ?? []).filter((e) => !e.set).map((e) => `env ${e.name} is not set`),
    ...(summary.files ?? []).filter((f) => !f.readable).map((f) => `file ${f.path} is not readable`),
    ...(summary.failures ?? []).map((f) => `${f.what}: ${f.reason}${f.exit == null ? '' : ` (exit ${f.exit})`}`),
  ]
}

// HO-845: what the item API shows for k at `hash` — each stage's status
// (`not_started` when it has no row yet), the failed stage and its findings,
// and whether its Approve card may show.
export function commandChecksView(itemId, index, hash) {
  const live = liveStages(itemId, index, hash)
  const stages = COMMAND_CHECK_STAGES.map((stage) => ({ stage, status: live[stage]?.status ?? 'not_started', reason: live[stage]?.reason ?? null }))
  const failed = stages.find((s) => s.status === 'fail') ?? null
  return {
    index,
    hash,
    stages,
    failedStage: failed?.stage ?? null,
    findings: failed ? findingsOf(live[failed.stage]) : [],
    approvable: stages.every((s) => s.status === 'pass'),
  }
}
