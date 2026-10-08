// Domain operations over SQLite. Every mutation notifies subscribers so the
// HTTP layer can push fresh state to SSE clients.

import { randomUUID } from 'node:crypto'
import { db } from './db.js'
import { GATE_ACTION_MARGIN_MS, PREMERGE_SKIP_MAX_AGE_MS } from './config.js'
import {
  STEPS,
  PHASES,
  isClosed,
  isAbandoned,
  isBlocked,
  isBlockedByAbandoned,
  curStep,
  IMPLEMENT_STEP_INDEX,
  REVIEW_STEP_INDEX,
  ACCEPT_GATE_INDEX,
  DEPLOY_STEP_INDEX,
  agentStepIndexes,
} from '../../domain/js/lifecycle.js'
import { isPriority } from '../../domain/js/priorities.js'
import { isPersona, personaLabel, personasFromRow } from './personas.js'
import { priorityFromLabels } from './priorityLabels.js'
import { getActiveProjectId, setSetting } from './settings.js'
import { parseRuleBlock } from './ruleBlock.js'

const listeners = new Set()

export function onChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify() {
  listeners.forEach((fn) => fn())
}

export function notifyChange() {
  notify()
}

// The orchestrator registers itself here at init (avoids a module cycle).
let agentRunner = { kick: () => {}, cancel: () => {}, pause: () => {} }

// A runner without pause() (HZ-194 added it) pauses by cancelling, as before.
export function registerAgentRunner(runner) {
  agentRunner = { pause: (id) => runner.cancel(id, 'cancelled'), ...runner }
}

// The orchestrator polls the farm for {state, reason} per active run_id and
// registers a cache lookup here (HZ-54) — a plain synchronous read, never a
// network call, so listItems()/the SSE snapshot never await the farm. Absent
// a real farm (mock mode) or any entry for a run, this defaults to {} below,
// which reads as "running" — today's presentation.
let runStateProvider = () => ({})

export function registerRunStateProvider(provider) {
  runStateProvider = provider
}

// ---- HZ-216: long gate actions (pre-merge checks + merge, conflict resolution) ----
//
// One persisted gate_action row per (item, kind) — see db.js. It is both the
// server's 409 lock and what every client is shown (listItems' gateAction and
// HZ-188's conflictRun), so the two cannot disagree, and both survive a reload
// and a restart. app.js's performGateApproval and orchestrator.js's
// resolveConflicts are the only claimers; each finishes its own row in a
// `finally`, and sweepGateActions() ends any row whose lease ran out.

// When this process started. A running row that started earlier has lost its
// owner — whatever it was running can no longer report back here.
export const BOOTED_AT = new Date().toISOString()

const selectGateEpoch = db.prepare(
  `SELECT (SELECT COALESCE(MAX(id), 0) FROM gate_decision WHERE item_id = ?) || ':' ||
          (SELECT COALESCE(MAX(id), 0) FROM step_run WHERE item_id = ?) AS epoch`,
)
const gateEpoch = (itemId) => selectGateEpoch.get(itemId, itemId).epoch

const claimGateActionStmt = db.prepare(
  `INSERT INTO gate_action (item_id, kind, state, run_token, epoch, detail, reason, failing_check, started_at, deadline_at, finished_at, started_by)
   VALUES (@itemId, @kind, 'running', @token, @epoch, @detail, NULL, NULL, @startedAt, @deadlineAt, NULL, @startedBy)
   ON CONFLICT(item_id, kind) DO UPDATE SET
     state = 'running', run_token = excluded.run_token, epoch = excluded.epoch, detail = excluded.detail,
     reason = NULL, failing_check = NULL, started_at = excluded.started_at,
     deadline_at = excluded.deadline_at, finished_at = NULL, started_by = excluded.started_by
   WHERE gate_action.state != 'running'`,
)
const selectGateAction = db.prepare('SELECT * FROM gate_action WHERE item_id = ? AND kind = ?')
const selectItemGateActions = db.prepare('SELECT * FROM gate_action WHERE item_id = ?')

// Takes the item's lock for `kind`. Returns { token } or null when a run of
// that kind is already going (the caller's 409). The lease is the run's own
// timeout plus GATE_ACTION_MARGIN_MS. startedBy (HZ-235) records who started
// it: 'human', or 'main_moved' for autoResolve.js's runs.
export function claimGateAction(itemId, kind, { detail = null, timeoutMs, startedBy = 'human' }) {
  const now = Date.now()
  const token = randomUUID()
  const res = claimGateActionStmt.run({
    itemId,
    kind,
    token,
    epoch: gateEpoch(itemId),
    detail,
    startedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + timeoutMs + GATE_ACTION_MARGIN_MS).toISOString(),
    startedBy,
  })
  if (res.changes === 0) return null
  notify()
  return { token }
}

// What a running action is doing now ("running checks on main + PR #12").
export function setGateActionDetail(itemId, kind, token, detail) {
  const res = db
    .prepare("UPDATE gate_action SET detail = ? WHERE item_id = ? AND kind = ? AND run_token = ? AND state = 'running'")
    .run(detail, itemId, kind, token)
  if (res.changes > 0) notify()
  return res.changes > 0
}

// Records the outcome. Only the claiming run's token matches, so a stale
// owner changes nothing; the real outcome does replace a sweep's timed_out,
// since it is better information.
export function finishGateAction(itemId, kind, token, { state, reason = null, failingCheck = null }) {
  const res = db
    .prepare(
      `UPDATE gate_action SET state = ?, reason = ?, failing_check = ?, finished_at = ?
       WHERE item_id = ? AND kind = ? AND run_token = ?`,
    )
    .run(state, reason, failingCheck, new Date().toISOString(), itemId, kind, token)
  if (res.changes > 0) notify()
  return res.changes > 0
}

export const GATE_ACTION_INTERRUPTED_REASON =
  'Horizon restarted while this ran and it never reported back before its time limit — nothing was merged or changed by it'
// HZ-250: the exact reason a self-deploy writes on the runs it stops.
export const DEPLOY_INTERRUPTED_REASON = 'server restarted for deploy'
export const GATE_ACTION_EXPIRED_REASON = 'no result before its time limit, so Horizon stopped waiting for it'

// HZ-250: the runs a self-deploy waits for before it restarts the server.
export function listRunningGateActions() {
  return db
    .prepare(
      `SELECT item_id, kind, started_at, detail FROM gate_action
       WHERE state = 'running' AND kind IN ('premerge','resolve') ORDER BY started_at, item_id, kind`,
    )
    .all()
    .map((row) => ({ itemId: row.item_id, kind: row.kind, startedAt: row.started_at, detail: row.detail }))
}

// HZ-321: a step label as one log-safe word ("Specialist agent implements"
// -> "specialist-agent-implements") for the deploy drain's DRAIN lines.
export function stepSlug(stepIndex) {
  const label = STEPS[stepIndex]?.label ?? `step-${stepIndex}`
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// HZ-321: the agent step runs a self-deploy waits for. The deploy step is left
// out: its own run published the release this deploy is installing, and it
// waits for that deploy to go live — draining it would wait on itself.
export function listRunningAgentSteps() {
  return db
    .prepare("SELECT id, item_id, step_index, started_at FROM step_run WHERE status = 'active' AND step_index != ? ORDER BY id")
    .all(DEPLOY_STEP_INDEX)
    .map((row) => ({ runId: row.id, itemId: row.item_id, stepIndex: row.step_index, step: stepSlug(row.step_index), startedAt: row.started_at }))
}

// HZ-250: ends the listed runs as `interrupted` when a deploy's wait ran out.
// Only a row still running is moved; one that finished meanwhile keeps its
// outcome. Returns the rows it actually moved.
//
// The run_token is rotated on purpose: it is what makes the owner's late
// finishGateAction()/setGateActionDetail() — still pending in this process
// until the restart — match nothing, so `interrupted` is never overwritten.
export function interruptGateActionsForDeploy(runs) {
  const end = db.prepare(
    `UPDATE gate_action
        SET state = 'interrupted', reason = @reason, finished_at = @now, run_token = @token
      WHERE item_id = @itemId AND kind = @kind
        AND state = 'running' AND kind IN ('premerge','resolve')`,
  )
  const now = new Date().toISOString()
  const moved = db.transaction(() =>
    runs.filter(
      ({ itemId, kind }) =>
        end.run({ itemId, kind, reason: DEPLOY_INTERRUPTED_REASON, now, token: `deploy:${randomUUID()}` }).changes > 0,
    ),
  )()
  if (moved.length > 0) notify()
  return moved.map(({ itemId, kind }) => ({ itemId, kind }))
}

// Ends every running row whose lease has run out: `interrupted` when it
// started before this process (its owner is gone), `timed_out` otherwise.
// Returns how many rows it moved.
export function sweepGateActions({ bootedAt = BOOTED_AT, now = new Date() } = {}) {
  const at = now.toISOString()
  const expired = db.prepare("SELECT item_id, kind, started_at FROM gate_action WHERE state = 'running' AND deadline_at < ?").all(at)
  const end = db.prepare(
    "UPDATE gate_action SET state = ?, reason = ?, finished_at = ? WHERE item_id = ? AND kind = ? AND state = 'running'",
  )
  let moved = 0
  for (const row of expired) {
    const interrupted = row.started_at < bootedAt
    moved += end.run(
      interrupted ? 'interrupted' : 'timed_out',
      interrupted ? GATE_ACTION_INTERRUPTED_REASON : GATE_ACTION_EXPIRED_REASON,
      at,
      row.item_id,
      row.kind,
    ).changes
  }
  if (moved > 0) notify()
  return moved
}

function gateActionView(row) {
  if (!row) return null
  return {
    kind: row.kind,
    state: row.state,
    detail: row.detail,
    since: row.started_at,
    deadline: row.deadline_at,
    finishedAt: row.finished_at,
    reason: row.reason,
    failingCheck: row.failing_check,
    startedBeforeRestart: row.started_at < BOOTED_AT,
  }
}

export function getGateAction(itemId, kind) {
  return gateActionView(selectGateAction.get(itemId, kind))
}

// HZ-188's conflictRun, unchanged in shape: { state, since, reason }, where
// since is when it started while running and when it ended after. A lease
// that ran out reads as `failed`, a state older clients already know.
function conflictRunView(row) {
  if (!row) return null
  const lapsed = row.state === 'timed_out' || row.state === 'interrupted'
  return {
    state: lapsed ? 'failed' : row.state,
    since: row.finished_at ?? row.started_at,
    reason: row.reason,
  }
}

export function getConflictRun(itemId) {
  return conflictRunView(selectGateAction.get(itemId, 'resolve'))
}

// ---- HZ-257: the farm's own check passes (db.js check_pass) ----

// The farm report fields that carry a pass — the implement step's artifacts
// and the conflict resolver's reply. farm/check_record.py names them too.
export const CHECKS_PASSED_SHA_KEY = 'checks_passed_sha'
export const CHECKS_FINISHED_AT_KEY = 'checks_finished_at'

const CHECK_PASS_SHA_RE = /^[0-9a-f]{40}$/
const CHECK_PASS_FUTURE_SLACK_MS = 5 * 60 * 1000
const CHECK_PASS_KEEP_MS = Math.max(7 * 24 * 60 * 60 * 1000, PREMERGE_SKIP_MAX_AGE_MS)

// Records that `sha` passed the repo's checks for this item. Never throws and
// never blocks its caller's run: anything doubtful (a bad sha, a finish time
// that is unparseable or in the future, a DB error) is logged and refused,
// which only means the next Accept runs pre-merge. Returns whether it stored.
export function recordCheckPass({ repo, itemId, sha, finishedAt, source }) {
  try {
    const finishedMs = typeof finishedAt === 'string' ? Date.parse(finishedAt) : NaN
    if (
      typeof repo !== 'string' ||
      !repo ||
      typeof sha !== 'string' ||
      !CHECK_PASS_SHA_RE.test(sha) ||
      !Number.isFinite(finishedMs) ||
      finishedMs > Date.now() + CHECK_PASS_FUTURE_SLACK_MS
    ) {
      console.warn(`[check_pass] not recorded for ${itemId}: bad sha or finish time`)
      return false
    }
    db.prepare('INSERT INTO check_pass (repo, item_id, sha, finished_at, source) VALUES (?, ?, ?, ?, ?)').run(
      repo,
      itemId,
      sha,
      new Date(finishedMs).toISOString(),
      source,
    )
    db.prepare('DELETE FROM check_pass WHERE finished_at < ?').run(new Date(Date.now() - CHECK_PASS_KEEP_MS).toISOString())
    return true
  } catch (err) {
    console.warn(`[check_pass] not recorded for ${itemId}: ${err.message}`)
    return false
  }
}

// The newest pass for exactly this repo, item and sha that finished within
// maxAgeMs, or null. Exact equality only — never another sha, repo or item.
// May throw; app.js treats a throw as "run pre-merge".
export function findCheckPass({ repo, itemId, sha, maxAgeMs, now = Date.now() }) {
  const row = db
    .prepare(
      `SELECT sha, finished_at, source FROM check_pass
       WHERE repo = ? AND item_id = ? AND sha = ? AND finished_at >= ?
       ORDER BY finished_at DESC LIMIT 1`,
    )
    .get(repo, itemId, sha, new Date(now - maxAgeMs).toISOString())
  return row ? { sha: row.sha, finishedAt: row.finished_at, source: row.source } : null
}

// The item's gate action for the UI: a running one if any, else the latest
// finished one from this visit to the gate. A merge is also kept once the
// gate has advanced past Accept — it is what the done Accept step shows — but
// never on a later visit back to the gate.
function itemGateAction(rows, itemId, cursor) {
  const running =
    rows.find((r) => r.state === 'running' && r.kind === 'premerge') || rows.find((r) => r.state === 'running')
  if (running) return gateActionView(running)
  const finished = rows
    .filter((r) => r.finished_at)
    .sort((a, b) => (a.finished_at < b.finished_at ? 1 : -1))[0]
  if (!finished) return null
  if (finished.state === 'merged' && cursor > ACCEPT_GATE_INDEX) return gateActionView(finished)
  if (finished.state === 'merged' && cursor < ACCEPT_GATE_INDEX) return null
  if (finished.epoch !== gateEpoch(itemId)) return null
  return gateActionView(finished)
}

// ---- projects & repos ----

// `checks` (HZ-245) adds each repo's check commands, and (HZ-304) its
// 'no checks' / 'no deploy' marks; off for consumers with no use for them.
export function listProjects({ checks = true } = {}) {
  const projects = db.prepare('SELECT * FROM project ORDER BY name').all()
  const repos = db.prepare('SELECT * FROM project_repo ORDER BY repo').all()
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    enabled: !!p.enabled,
    autopilot: p.autopilot,
    autopilotEvents: selectAutopilotEvents.all(p.id),
    repos: repos
      .filter((r) => r.project_id === p.id)
      .map((r) => ({ repo: r.repo, prefix: r.prefix, ...(checks ? { checks: repoChecks(r), marks: repoMarks(r) } : {}) })),
  }))
}

// ---- per-repo check commands (HZ-245) ----
// The four commands farm/checks.py runs for a repo, in this order. A human
// sets them in Admin; NULL everywhere means "not configured" — HZ-304: the
// repo's implement fails until they are set or it is marked 'no checks'.

export const CHECK_SLOTS = ['install', 'test', 'lint', 'e2e']

function repoChecks(row) {
  return Object.fromEntries(CHECK_SLOTS.map((slot) => [slot, row[`check_${slot}`] ?? null]))
}

// What the farm is sent with a task: the stored slots, or null when the repo
// is unknown or has nothing configured (the caller then sends nothing).
export function getRepoCheckCommands(repoFullName) {
  const row = repoFullName ? findRepo(repoFullName) : null
  if (!row) return null
  const checks = repoChecks(row)
  return CHECK_SLOTS.some((slot) => checks[slot] != null) ? checks : null
}

// The ONLY writer of the check columns, and its only caller is the
// PIN-gated Admin route in app.js: no agent, step or farm path may change the
// commands that judge its own work. Each string is stored exactly as entered;
// empty or whitespace-only becomes NULL (the same rule as the farm's).
export function setRepoCheckCommands(projectId, repoFullName, checks) {
  const row = db.prepare('SELECT id FROM project_repo WHERE project_id = ? AND repo = ?').get(projectId, repoFullName)
  if (!row) return { error: 'not_found' }
  const values = CHECK_SLOTS.map((slot) => {
    const value = checks?.[slot]
    return typeof value === 'string' && value.trim() ? value : null
  })
  db.prepare(
    'UPDATE project_repo SET check_install = ?, check_test = ?, check_lint = ?, check_e2e = ? WHERE id = ?',
  ).run(...values, row.id)
  notify()
  return { ok: true, checks: Object.fromEntries(CHECK_SLOTS.map((slot, i) => [slot, values[i]])) }
}

// ---- repo readiness (HZ-304) ----
// Why a repo with no check commands may still run checks, as sent to the farm
// (task `checks_waiver`, or `--checks-waiver` for farm/premerge.py and
// farm/validate.py). farm/checks.py CHECKS_WAIVERS holds the same strings.
export const CHECKS_WAIVER = Object.freeze({
  NO_CHECKS: 'no_checks',
  PREDATES_ENFORCEMENT: 'predates_enforcement',
})

function repoMarks(row) {
  return { noChecks: row.no_checks === 1, noDeploy: row.no_deploy === 1 }
}

// Everything dispatch needs to judge a repo's readiness, read fresh each
// time: the configured commands (null when none), the two marks, and when
// enforcement began for it (null for a repo connected after HZ-304).
export function getRepoConfig(repoFullName) {
  const row = repoFullName ? findRepo(repoFullName) : null
  if (!row) return null
  return { checks: getRepoCheckCommands(repoFullName), ...repoMarks(row), enforcedSince: row.enforced_since ?? null }
}

// The ONLY writer of no_checks / no_deploy, and its only caller is the
// PIN-gated Admin route in app.js — the same rule as setRepoCheckCommands:
// no agent may excuse its own repo from checks or deploys. A mark left out
// of `marks` keeps its stored value. One exception: the one-time HZ-353 seed
// (seedCodeOnlyTargets in deployTargets.js) may only CLEAR no_deploy, and
// only for a code-only row it just inserted that passes checkRunnable.
export function setRepoMarks(projectId, repoFullName, marks) {
  const row = db.prepare('SELECT * FROM project_repo WHERE project_id = ? AND repo = ?').get(projectId, repoFullName)
  if (!row) return { error: 'not_found' }
  const next = { ...repoMarks(row) }
  if (typeof marks?.noChecks === 'boolean') next.noChecks = marks.noChecks
  if (typeof marks?.noDeploy === 'boolean') next.noDeploy = marks.noDeploy
  db.prepare('UPDATE project_repo SET no_checks = ?, no_deploy = ? WHERE id = ?').run(
    next.noChecks ? 1 : 0,
    next.noDeploy ? 1 : 0,
    row.id,
  )
  notify()
  return { ok: true, marks: next }
}

// Whether the item's first implement run started before `iso` (a
// datetime('now') string, the same format step_run.started_at uses).
export function implementStartedBefore(itemId, iso) {
  if (!iso) return false
  const row = db
    .prepare('SELECT MIN(started_at) AS first FROM step_run WHERE item_id = ? AND step_index = ?')
    .get(itemId, IMPLEMENT_STEP_INDEX)
  return row?.first != null && row.first < iso
}

export function listRepos() {
  return db.prepare('SELECT repo, prefix, project_id FROM project_repo ORDER BY repo').all()
}

export function findRepo(repoFullName) {
  return db.prepare('SELECT * FROM project_repo WHERE repo = ?').get(repoFullName) || null
}

export function createProject(name) {
  const existing = db.prepare('SELECT id FROM project WHERE name = ?').get(name)
  if (existing) return { error: 'exists' }
  // The first project becomes active and enabled without a farm restart —
  // nothing was running before it existed. Later ones start disabled (HZ-207).
  const first = getActiveProjectId() == null
  const id = db.prepare('INSERT INTO project (name, enabled) VALUES (?, ?)').run(name, first ? 1 : 0).lastInsertRowid
  if (first) {
    setSetting('active_project_id', String(id))
    setSetting('farm_project_id', String(id))
  }
  notify()
  return { ok: true, id, name }
}

// HZ-207: the farm dispatches every enabled project's items. Items with no
// project (local demo items) are always on, and so is everything before any
// project has been chosen — the rule the single active project had.
export function isProjectEnabled(projectId) {
  if (projectId == null || getActiveProjectId() == null) return true
  return enabledProjectIds().has(projectId)
}

// The ids of every enabled project, read in one query — the single source of
// the "enabled" rule for isProjectEnabled and listItems' 'enabled' scope.
export function enabledProjectIds() {
  return new Set(db.prepare('SELECT id FROM project WHERE enabled = 1').all().map((r) => r.id))
}

// Writes the flag only: a disabled project's items are never cancelled,
// paused or modified, and its in-flight steps finish normally.
export function setProjectEnabled(projectId, enabled) {
  const changes = db.prepare('UPDATE project SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, projectId).changes
  if (changes === 0) return { error: 'not_found' }
  notify()
  return { ok: true }
}

// ---- HZ-270: per-project Autopilot (off | shadow | on) ----

export const AUTOPILOT_MODES = ['off', 'shadow', 'on']

const selectAutopilotEvents = db.prepare(
  "SELECT old_value AS old, new_value AS new, who, created_at AS at FROM project_event WHERE project_id = ? AND kind = 'autopilot' ORDER BY id DESC LIMIT 3",
)

// HZ-274: the WhatsApp kill switch names a project, not an id. Case and
// surrounding spaces are ignored. { id, name } or null when nothing matches.
export function findProjectByName(name) {
  const wanted = String(name ?? '').trim()
  if (!wanted) return null
  return db.prepare('SELECT id, name FROM project WHERE lower(trim(name)) = lower(?) ORDER BY id LIMIT 1').get(wanted) ?? null
}

// The ONLY writer of project.autopilot. Two callers in app.js: the PIN-gated
// Admin route (any mode) and HZ-274's WhatsApp kill switch ('off' only). The
// flag and its audit row land in one transaction, and a same-value write
// records nothing.
export function setProjectAutopilot(projectId, mode, who) {
  if (!AUTOPILOT_MODES.includes(mode)) return { error: 'invalid_mode' }
  const result = db.transaction(() => {
    const row = db.prepare('SELECT autopilot FROM project WHERE id = ?').get(projectId)
    if (!row) return { error: 'not_found' }
    if (row.autopilot === mode) return { ok: true, old: mode, new: mode, unchanged: true }
    db.prepare('UPDATE project SET autopilot = ? WHERE id = ?').run(mode, projectId)
    db.prepare(
      "INSERT INTO project_event (project_id, kind, old_value, new_value, who) VALUES (?, 'autopilot', ?, ?, ?)",
    ).run(projectId, row.autopilot, mode, who)
    return { ok: true, old: row.autopilot, new: mode }
  })()
  if (result.ok && !result.unchanged) notify()
  return result
}

// ---- HZ-248: 'Validate project' results ----

// The ONLY writer of project_validation; its one caller is
// projectValidate.validateProject(). Details arrive already scrubbed.
export function recordValidation({ projectId, startedAt, finishedAt, pass, checks, who }) {
  return db
    .prepare(
      'INSERT INTO project_validation (project_id, started_at, finished_at, pass, checks_json, who) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(projectId, startedAt, finishedAt, pass ? 1 : 0, JSON.stringify(checks), who).lastInsertRowid
}

// The project's newest result, or null when it was never validated.
export function latestValidation(projectId) {
  const row = db
    .prepare('SELECT * FROM project_validation WHERE project_id = ? ORDER BY id DESC LIMIT 1')
    .get(projectId)
  if (!row) return null
  return {
    id: row.id,
    projectId: row.project_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    pass: row.pass === 1,
    checks: JSON.parse(row.checks_json),
  }
}

// SH for shoreward, US for ui-service, LS for ledger-service… deduped
// against prefixes already taken.
function generatePrefix(repoFullName) {
  const name = repoFullName.split('/')[1] || repoFullName
  const words = name.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const base = (words.length >= 2 ? words.map((w) => w[0]).join('').slice(0, 3) : words[0].slice(0, 2)).toUpperCase()
  const taken = new Set(db.prepare('SELECT prefix FROM project_repo').all().map((r) => r.prefix))
  let candidate = base
  for (let i = 2; taken.has(candidate); i++) candidate = base + i
  return candidate
}

export function addRepoToProject(projectId, repoFullName) {
  if (!db.prepare('SELECT id FROM project WHERE id = ?').get(projectId)) return { error: 'project_not_found' }
  if (findRepo(repoFullName)) return { error: 'repo_already_connected' }
  const prefix = generatePrefix(repoFullName)
  db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(projectId, repoFullName, prefix)
  purgeDemoItems()
  notify()
  return { ok: true, repo: repoFullName, prefix }
}

// Disconnecting stops sync for the repo (existing items keep their history;
// they just stop receiving updates until the repo is reconnected).
export function removeRepoFromProject(projectId, repoFullName) {
  const result = db.prepare('DELETE FROM project_repo WHERE project_id = ? AND repo = ?').run(projectId, repoFullName)
  if (result.changes === 0) return { error: 'not_found' }
  notify()
  return { ok: true }
}

// ---- queries ----

// last_run_ended_at (HZ-228) is a correlated subquery on idx_step_run_item, so
// the board's state_since adds no per-item query.
const selectItems = db.prepare(
  `SELECT w.*, (SELECT MAX(s.ended_at) FROM step_run s WHERE s.item_id = w.id) AS last_run_ended_at
   FROM work_item w ORDER BY w.id`,
)
const selectEvents = db.prepare('SELECT who, text, color, initials, created_at FROM event WHERE item_id = ? ORDER BY id DESC LIMIT 20')
const selectOutputs = db.prepare(
  "SELECT step_index, attempt, output, artifact FROM step_run WHERE item_id = ? AND status = 'done' ORDER BY id",
)
// Counts done+artifact rows only (a strict subset of the done rows above —
// some steps mark done without ever setting an artifact), so the board can
// show "attempt N of Y" without claiming a version exists that isn't
// actually reachable via listStepAttempts/the artifact route (HZ-46).
const selectAttemptCounts = db.prepare(
  "SELECT step_index, COUNT(*) AS n FROM step_run WHERE item_id = ? AND status = 'done' AND artifact IS NOT NULL GROUP BY step_index",
)

function stepOutputs(itemId) {
  const map = {}
  const attemptCounts = {}
  for (const row of selectAttemptCounts.all(itemId)) attemptCounts[row.step_index] = row.n
  for (const row of selectOutputs.all(itemId)) {
    // last write wins = latest attempt; label so non-UI clients (the
    // WhatsApp concierge) can name the step without a STEPS copy
    map[row.step_index] = {
      output: row.output,
      attempt: row.attempt,
      artifact: row.artifact || null,
      attemptCount: attemptCounts[row.step_index] || 0,
      label: STEPS[row.step_index]?.label ?? null,
    }
  }
  return map
}

// The newest done attempt's artifact for one step, or null. Exported (HZ-141)
// so gateNotifier.js can quote the PM's recommendation into a gate
// notification through the same latest-attempt-wins rule stepOutputs() applies
// above, rather than opening a second raw query onto step_run. `artifact`
// falls back to `output` because some steps mark done with only a summary.
export function latestArtifact(itemId, stepIndex) {
  const row = db
    .prepare(
      "SELECT output, artifact FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'done' ORDER BY id DESC LIMIT 1",
    )
    .get(itemId, stepIndex)
  return row ? (row.artifact || row.output || null) : null
}

// ---- artifact version history (HZ-46) ----
// Every retained done+artifact attempt for a step, oldest first, each
// labelled (where one exists) with the feedback that drove it: the newest
// feedback row targeting this step's agent whose created_at falls between
// the previous attempt's end and this attempt's start. A heuristic, not a
// guarantee — feedback.target records an agent name, not a step_index, so
// two steps run by the same agent could in rare cases cross-attribute.
const selectDoneAttempts = db.prepare(
  "SELECT attempt, started_at, ended_at FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'done' AND artifact IS NOT NULL ORDER BY attempt ASC",
)
const selectDrivingFeedback = db.prepare(
  'SELECT message FROM feedback WHERE item_id = ? AND target = ? AND created_at > ? AND created_at <= ? ORDER BY created_at DESC LIMIT 1',
)

export function listStepAttempts(itemId, stepIndex) {
  const agent = STEPS[stepIndex]?.agent || ''
  const rows = selectDoneAttempts.all(itemId, stepIndex)
  return rows.map((row, i) => {
    const since = i > 0 ? rows[i - 1].ended_at : '0000-01-01 00:00:00'
    const feedback = agent ? (selectDrivingFeedback.get(itemId, agent, since, row.started_at)?.message ?? null) : null
    return { attempt: row.attempt, startedAt: row.started_at, endedAt: row.ended_at, feedback }
  })
}

// `id` rides along so the UI can tail the run's live log (HZ-5).
const selectActiveRun = db.prepare(
  "SELECT id, step_index, attempt, started_at FROM step_run WHERE item_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
)

// Folds the farm's cached {state, reason} onto an active run (HZ-54). No
// entry for this run — mock mode, an old/unreachable farm, or a poll that
// simply hasn't landed yet — defaults to 'running', i.e. today's behavior.
function withRunState(activeRun) {
  if (!activeRun) return null
  const cached = runStateProvider()[String(activeRun.id)]
  return { ...activeRun, state: cached?.state || 'running', reason: cached?.reason || null }
}

// ---- dependencies (HZ-78) ----
// item_id is blocked until every depends_on_id row it names has closed (see
// domain/js/lifecycle.js isBlocked). Enforced at dispatch time in orchestrator.js's
// runnable() — the same gate that already decides dispatch — via blockersOf
// below; the API-facing blocked/blockedBy fields here are read-only
// reporting of that same derived state, not a second source of truth.

const selectBlockers = db.prepare(
  `SELECT w.* FROM work_item_dependency d JOIN work_item w ON w.id = d.depends_on_id WHERE d.item_id = ? ORDER BY d.depends_on_id`,
)
const selectDependents = db.prepare(
  `SELECT w.* FROM work_item_dependency d JOIN work_item w ON w.id = d.item_id WHERE d.depends_on_id = ? ORDER BY d.item_id`,
)
const selectDependentIds = db.prepare('SELECT item_id FROM work_item_dependency WHERE depends_on_id = ?')
const selectDependsOnIds = db.prepare('SELECT depends_on_id FROM work_item_dependency WHERE item_id = ?')

// Exported so the orchestrator can gate dispatch on the same derived state
// this module reports through listItems() — never two separate checks.
export function blockersOf(id) {
  return selectBlockers.all(id)
}

// DFS over the dependency graph starting at dependsOnId, following its own
// "depends on" edges. Reaching `id` means dependsOnId already (directly or
// transitively) depends on id, so adding id -> dependsOnId would close a
// cycle. Called BEFORE any write in addDependency — fail closed, no graph
// that can deadlock dispatch is ever persisted.
function wouldCycle(id, dependsOnId) {
  const seen = new Set()
  const stack = [dependsOnId]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (cur === id) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const row of selectDependsOnIds.all(cur)) stack.push(row.depends_on_id)
  }
  return false
}

// HZ-313: the same check addDependency runs, for split.js to refuse a plan
// whose already-filed upstream item now depends on this one.
export function wouldCycleBetween(id, dependsOnId) {
  return wouldCycle(id, dependsOnId)
}

function dependencyFields(id) {
  const blockers = blockersOf(id)
  const dependents = selectDependents.all(id)
  return {
    blocked: isBlocked(blockers),
    blockedByAbandoned: isBlockedByAbandoned(blockers),
    blockedBy: blockers
      .filter((b) => !isClosed(b))
      .map((b) => ({ id: b.id, title: b.title, abandoned: isAbandoned(b) })),
    dependents: dependents
      .filter((d) => !isClosed(d))
      .map((d) => ({ id: d.id, title: d.title, abandoned: isAbandoned(d) })),
  }
}

// Wakes every item that names `id` as a blocker — called once `id` has
// actually closed, from every place isClosed can flip false -> true
// (approveGate, approveGateFromGithub, and upsertFromGithub's GitHub-close
// sync). kick() itself re-checks runnable() (which re-checks blockersOf), so
// a dependent with a second still-open blocker safely no-ops here.
function wakeDependents(id) {
  for (const row of selectDependentIds.all(id)) {
    releaseRuleBlockIfSatisfied(row.item_id)
    agentRunner.kick(row.item_id)
  }
}

// HZ-346: a rule-blocked item restarts once a dependency it gained after the
// block, and every other blocker, has closed. A dependency that predates the
// block is not why it is waiting, so it never releases it; nor does removing
// one. Returns whether the block was cleared — the caller kicks.
export function releaseRuleBlockIfSatisfied(id) {
  const row = db.prepare('SELECT rule_block_json FROM work_item WHERE id = ?').get(id)
  const block = parseRuleBlock(row?.rule_block_json)
  if (!block?.blockedAt) return false
  const blockers = blockersOf(id)
  if (blockers.length === 0 || isBlocked(blockers)) return false
  const added = db
    .prepare('SELECT 1 FROM work_item_dependency WHERE item_id = ? AND created_at >= ? LIMIT 1')
    .get(id, block.blockedAt)
  if (!added) return false
  db.prepare(`UPDATE work_item SET rule_block_json = NULL, ${touch} WHERE id = ?`).run(id)
  addEvent(id, {
    who: 'Horizon',
    text: 'its dependencies are closed — the rule block is cleared and implement restarts',
    color: '#5E4380',
    initials: 'HZ',
  })
  return true
}

// Called from abandonItem: an abandoned blocker can never close, so its
// dependents can never satisfy that dependency by waiting. They are NOT
// auto-unblocked (removing someone else's dependency edge without asking is
// its own surprise) and NOT paused (paused is a human action with a Resume
// button — see domain/js/lifecycle.js and the guardrails this item shipped under).
// Instead each live dependent gets an event naming the abandoned blocker and
// keeps reading blocked: true / blockedByAbandoned: true in the API until a
// human calls removeDependency (or replaces the dependency) — visible and
// actionable, never silently stuck.
function escalateDependents(blockerId, actor) {
  const blocker = getItem(blockerId)
  for (const row of selectDependentIds.all(blockerId)) {
    const dependent = getItem(row.item_id)
    if (!dependent || isClosed(dependent) || isAbandoned(dependent)) continue
    addEvent(row.item_id, {
      who: 'Horizon',
      text: `blocker ${blockerId} (${blocker?.title || blockerId}) was abandoned by ${actor} — this item stays blocked until the dependency is removed or replaced`,
      color: '#9C333E',
      initials: 'HZ',
    })
  }
}

// Declares that `id` cannot proceed until `dependsOnId` closes. Validated,
// in order, before any write: both items exist, no self-dependency, the
// dependent isn't already closed/abandoned, the blocker isn't abandoned
// (an abandoned blocker can never satisfy a dependency, so declaring one is
// rejected up front rather than immediately needing escalation), and finally
// the cycle check — fail closed, matching the guardrail that no graph able
// to deadlock dispatch is ever persisted.
export function addDependency(id, dependsOnId, actor = 'You') {
  const it = getItem(id)
  if (!it) return { error: 'not_found' }
  if (disabledProject(it)) return { error: 'project_not_active' }
  if (isClosed(it)) return { error: 'closed' }
  if (isAbandoned(it)) return { error: 'abandoned' }
  if (id === dependsOnId) return { error: 'self_dependency', message: `${id} cannot depend on itself` }
  const blocker = getItem(dependsOnId)
  if (!blocker) return { error: 'blocker_not_found' }
  if (isAbandoned(blocker)) {
    return { error: 'blocker_abandoned', message: `${dependsOnId} is abandoned and can never satisfy a dependency` }
  }

  const existing = db.prepare('SELECT 1 FROM work_item_dependency WHERE item_id = ? AND depends_on_id = ?').get(id, dependsOnId)
  if (existing) return { ok: true, unchanged: true, ...dependencyFields(id) }

  if (wouldCycle(id, dependsOnId)) {
    return {
      error: 'cycle',
      message: `${dependsOnId} already depends on ${id}, directly or transitively — adding this dependency would create a cycle`,
    }
  }

  db.prepare('INSERT INTO work_item_dependency (item_id, depends_on_id, created_by) VALUES (?, ?, ?)').run(id, dependsOnId, actor)
  addEvent(id, { who: actor, text: `added a dependency on ${dependsOnId} (${blocker.title})`, color: '#5E4380', initials: 'YOU' })
  // HZ-346: a rule-blocked item that now depends only on closed items is
  // released at once — the dependency it needed has already shipped.
  const released = releaseRuleBlockIfSatisfied(id)
  notify()
  if (released) agentRunner.kick(id)
  return { ok: true, ...dependencyFields(id) }
}

// Removes a dependency edge — the human remedy for a stale/abandoned blocker
// (see escalateDependents), or simply undoing a mistaken declaration. Always
// re-kicks: if this was the last open blocker, the item is runnable again
// and must start automatically, not wait for an unrelated dispatch trigger.
export function removeDependency(id, dependsOnId, actor = 'You') {
  const it = getItem(id)
  if (!it) return { error: 'not_found' }
  if (disabledProject(it)) return { error: 'project_not_active' }
  const result = db.prepare('DELETE FROM work_item_dependency WHERE item_id = ? AND depends_on_id = ?').run(id, dependsOnId)
  if (result.changes === 0) return { error: 'not_found' }
  addEvent(id, { who: actor, text: `removed the dependency on ${dependsOnId}`, color: '#5E4380', initials: 'YOU' })
  notify()
  agentRunner.kick(id)
  return { ok: true, ...dependencyFields(id) }
}

// Where an item stands, resolved server-side so non-UI clients (the WhatsApp
// concierge) don't need their own copy of the STEPS table.
function currentStepOf(row) {
  if (isClosed(row)) return { index: row.cursor, label: 'Closed', kind: 'done', phase: 'Done', gate: false }
  const step = STEPS[row.cursor]
  return { index: row.cursor, label: step.label, kind: step.kind, phase: PHASES[step.phase], gate: step.kind === 'gate' }
}

// Which items a snapshot carries. scope 'active' (the default) is the active
// project's items; 'enabled' is every enabled project's (HZ-208 — the board,
// tracker and approvals filter it client-side). Both include local demo items,
// which have no project, and everything before any project has been chosen.
// 'enabled' never carries a disabled project's items.
//
// HZ-318: `stepOutputs: false` leaves each item's stepOutputs off — 79% of the
// board's bytes. The live feed and GET /api/items?v=2 use it; the Tracker
// streams one item's outputs while it is open, through itemStepOutputs() below.
export function listItems({ scope = 'active', stepOutputs = true } = {}) {
  return selectItems
    .all()
    .filter(scopeFilter(scope))
    .map((row) => itemView(row, { stepOutputs }))
}

// The row filter behind listItems' scope, shared with itemStepOutputs so the
// per-item route can never show an item the list would not.
function scopeFilter(scope) {
  const activeId = getActiveProjectId()
  const enabled = scope === 'enabled' ? enabledProjectIds() : null
  const inScope = (projectId) => (enabled ? enabled.has(projectId) : projectId === activeId)
  return (row) => row.project_id == null || activeId == null || inScope(row.project_id)
}

// HZ-318: one item's stepOutputs exactly as listItems({ scope: 'enabled' })
// carries them, or null when the id is unknown or outside that scope.
// Runs once per open item per stream flush, so the statement is prepared once.
const selectItemScope = db.prepare('SELECT id, project_id FROM work_item WHERE id = ?')
export function itemStepOutputs(id) {
  const row = selectItemScope.get(id)
  if (!row || !scopeFilter('enabled')(row)) return null
  return stepOutputs(row.id)
}

// ---- duration estimates (HZ-229) ----

// The typical wall-clock duration of each agent step and of the two gate
// actions (Accept's pre-merge checks, Resolve conflicts), for the board's ETA.
// Farm-wide on purpose: step_run and gate_action carry no project, and the
// board shows one set of estimates whatever its project filter.
const DURATION_SAMPLE_LIMIT = 20
const DURATION_MIN_SAMPLES = 5
// Human gates are never sampled — only agent-kind steps get an arm.
const DURATION_STEP_INDEXES = agentStepIndexes()
const DURATION_GATE_KINDS = { premerge: 'merged', resolve: 'resolved' }
const durationSec = (end, start) => `(julianday(${end}) - julianday(${start})) * 86400`
// One statement, one bounded arm per key. A step's "most recent" runs are its
// highest ids (insertion order, walked by rowid); a gate action keeps one row
// per item, so its arms order by finished_at. Rows with a missing or
// backwards end time are skipped rather than counted.
const selectDurationSamples = db.prepare(
  [
    ...DURATION_STEP_INDEXES.map(
      () =>
        `SELECT * FROM (SELECT CAST(step_index AS TEXT) AS k, ${durationSec('ended_at', 'started_at')} AS sec
          FROM step_run WHERE step_index = ? AND status = 'done'
            AND julianday(ended_at) >= julianday(started_at)
          ORDER BY id DESC LIMIT ${DURATION_SAMPLE_LIMIT})`,
    ),
    ...Object.keys(DURATION_GATE_KINDS).map(
      () =>
        `SELECT * FROM (SELECT kind AS k, ${durationSec('finished_at', 'started_at')} AS sec
          FROM gate_action WHERE kind = ? AND state = ?
            AND julianday(finished_at) >= julianday(started_at)
          ORDER BY finished_at DESC LIMIT ${DURATION_SAMPLE_LIMIT})`,
    ),
  ].join(' UNION ALL '),
)

// Median in whole seconds; an even count averages the middle pair. Samples are
// first rounded to the millisecond so julianday's float noise can't tip a .5.
function medianSec(values) {
  const sorted = values.map((v) => Math.round(v * 1000) / 1000).sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2)
}

// { "<agent step index>": { medianSec, count } | null, premerge: …, resolve: … }
// — null below DURATION_MIN_SAMPLES. One query per call, computed fresh.
export function durationEstimates() {
  const rows = selectDurationSamples.all(...DURATION_STEP_INDEXES, ...Object.entries(DURATION_GATE_KINDS).flat())
  const samples = new Map()
  for (const { k, sec } of rows) {
    if (!samples.has(k)) samples.set(k, [])
    samples.get(k).push(sec)
  }
  const keys = [...DURATION_STEP_INDEXES.map(String), ...Object.keys(DURATION_GATE_KINDS)]
  return Object.fromEntries(
    keys.map((k) => {
      const values = samples.get(k) || []
      return [k, values.length < DURATION_MIN_SAMPLES ? null : { medianSec: medianSec(values), count: values.length }]
    }),
  )
}

// The item's conflictRun and gateAction exactly as listItems shows them —
// itemGateAction's epoch rule included. HZ-279's notifier reads them through
// this too, so it applies the same busy rule as the UI.
export function itemGateFields(row) {
  const gateActions = selectItemGateActions.all(row.id)
  return {
    conflictRun: conflictRunView(gateActions.find((r) => r.kind === 'resolve')),
    gateAction: itemGateAction(gateActions, row.id, row.cursor),
  }
}

// SQLite's datetime('now') is UTC written without a zone ("2026-10-02 09:14:03"),
// which Date.parse would read as local time. Values already in ISO form (the
// gate_action timestamps) pass through unchanged.
function toIsoUtc(ts) {
  if (typeof ts !== 'string' || !ts) return null
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(ts) ? `${ts.replace(' ', 'T')}Z` : ts
  return Number.isNaN(Date.parse(iso)) ? null : iso
}

// HZ-333: the item's place in its deploy target's queue, for the board, or
// null when it is not queued. Read-only.
const selectQueuedEntry = db.prepare(`
  SELECT e.target, e.status, b.status AS batch_status, b.window_closes_at, b.tag
    FROM deploy_queue_entry e JOIN deploy_batch b ON b.id = e.batch_id
   WHERE e.item_id = ? AND e.status = 'queued'`)

export function deployQueueStateFor(itemId) {
  const row = selectQueuedEntry.get(itemId)
  return row ? { ...row, window_closes_at: toIsoUtc(row.window_closes_at) } : null
}

// HZ-333: gate 15's evidence for an item a deploy queue batch shipped — its
// latest entry released by a batch that went live, so a later batch moving
// last-good-tag never takes it away. Null otherwise. Read-only.
const selectShippedEntry = db.prepare(`
  SELECT b.tag, b.commit_sha, e.merge_sha
    FROM deploy_queue_entry e JOIN deploy_batch b ON b.id = e.batch_id
   WHERE e.item_id = ? AND e.status IN ('released','passed') AND b.live_at IS NOT NULL
   ORDER BY e.id DESC LIMIT 1`)

export function deployBatchFactsFor(itemId) {
  const row = selectShippedEntry.get(itemId)
  return row ? { tag: row.tag, commit: row.commit_sha, mergeSha: row.merge_sha, live: true } : null
}

// HZ-228: when the item entered its current state, for the board's elapsed
// label — ISO UTC, or null when the card shows no timer. Read-only. In order:
//   1. closed, abandoned, rejected or paused → null (paused has no pause
//      timestamp, so a paused card shows no timer);
//   2. an active run → its start. At the parallel review steps that is the
//      newest active run, not necessarily the cursor step's own;
//   3. a gate with a running gate action → the action's start;
//   4. a gate → the item's latest step_run end: domain/steps.json never has
//      two gates in a row, so that run is the one that parked it here. An item
//      created at a gate (seed data, GitHub import) has no runs and falls back
//      to created_at. HZ-185's forward to Accept closes no run, so there it
//      reads from the forwarded review's end;
//   5. anything else (an agent step not yet dispatched) → null.
function stateSince(row, activeRun, gateAction) {
  if (isClosed(row) || row.abandoned_at || row.rejected || row.paused) return null
  if (activeRun) return toIsoUtc(activeRun.started_at)
  if (STEPS[row.cursor]?.kind !== 'gate') return null
  if (gateAction?.state === 'running') return toIsoUtc(gateAction.since)
  return toIsoUtc(row.last_run_ended_at ?? row.created_at)
}

function itemView(row, { stepOutputs: withStepOutputs = true } = {}) {
  const activeRun = withRunState(selectActiveRun.get(row.id) || null)
  const gateFields = itemGateFields(row)
  return {
    id: row.id,
    title: row.title,
    priority: row.priority,
    desc: row.desc,
    metric: row.metric,
    guardrails: row.guardrails,
    issue: row.issue,
    repo: row.repo,
    project_id: row.project_id,
    pr: row.pr,
    pr_url: row.pr_url,
    pr_mergeable: row.pr_mergeable == null ? null : !!row.pr_mergeable,
    release_tag: row.release_tag,
    release_url: row.release_url,
    deploy_queue: deployQueueStateFor(row.id),
    personas: personasFromRow(row),
    cursor: row.cursor,
    currentStep: currentStepOf(row),
    paused: !!row.paused,
    rejected: !!row.rejected,
    // Last progress on this item, for the board's staleness filter (HZ-80) —
    // `updated_at` is already maintained by `touch` on every mutation below.
    last_activity_at: row.updated_at,
    abandoned_at: row.abandoned_at,
    abandoned_reason: row.abandoned_reason,
    abandoned_by: row.abandoned_by,
    events: selectEvents.all(row.id),
    ...(withStepOutputs ? { stepOutputs: stepOutputs(row.id) } : {}),
    activeRun,
    ...gateFields,
    state_since: stateSince(row, activeRun, gateFields.gateAction),
    reviewRejected: reviewRejected(row),
    forwardedReview: forwardedReview(row),
    ...dependencyFields(row.id),
    ruleBlock: parseRuleBlock(row.rule_block_json),
  }
}

// HZ-185: the latest automated review rejected this item and sent it back to
// implement — the only state a human may forward to Accept the code from. A
// rejection is the one thing that sets fix_findings_json with the cursor at
// implement; a passing review and every human send-back clear it. Shared with
// orchestrator.forwardRejectedReview so the button and the route agree.
export function reviewRejected(row) {
  return row.cursor === IMPLEMENT_STEP_INDEX && row.fix_findings_json != null
}

const selectForwardedRun = db.prepare('SELECT attempt, artifact, output FROM step_run WHERE id = ? AND item_id = ?')
const selectNewerReview = db.prepare(
  "SELECT 1 FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'done' AND id > ? LIMIT 1",
)

// HZ-185: the failing review a forward to Accept the code carried, keyed by
// the review run that was forwarded (not "the newest review"), or null. A
// review run since then (a send-back to review re-ran it) supersedes it.
function forwardedReview(row) {
  if (row.forwarded_review_run_id == null) return null
  if (selectNewerReview.get(row.id, REVIEW_STEP_INDEX, row.forwarded_review_run_id)) return null
  const run = selectForwardedRun.get(row.forwarded_review_run_id, row.id)
  return {
    runId: row.forwarded_review_run_id,
    by: row.forwarded_by,
    sha: row.forwarded_sha,
    attempt: run?.attempt ?? null,
    artifact: run ? run.artifact || run.output || null : null,
  }
}

export function getItem(id) {
  const row = db.prepare('SELECT * FROM work_item WHERE id = ?').get(id)
  if (!row) return null
  // `personas` is derived here, at the one seam every caller reads an item
  // through, so nothing downstream has to know about personas_json or the
  // legacy `persona` column (HZ-125). The raw columns stay on the object.
  return { ...row, paused: !!row.paused, rejected: !!row.rejected, personas: personasFromRow(row) }
}

// Human actions are only valid against an enabled project's items (HZ-207;
// the error code stays project_not_active, which waPollVotes.js keys on).
function disabledProject(item) {
  return !isProjectEnabled(item.project_id)
}

// ---- mutations ----

const touch = "updated_at = datetime('now')"
// A human-directed rework at or before implement starts the automated review
// loop over: fresh cycles, and no HZ-182 fix pass — a human send-back is an
// unscoped change, so the next implement and review are both full.
const RESET_REVIEW_STATE =
  ', review_cycle_count = 0, fix_pass = 0, fix_findings_json = NULL, last_reviewed_sha = NULL' +
  ', forwarded_review_run_id = NULL, forwarded_by = NULL, forwarded_sha = NULL'

export function addEvent(id, { who, text, color, initials }) {
  db.prepare('INSERT INTO event (item_id, who, text, color, initials) VALUES (?, ?, ?, ?, ?)').run(id, who, text, color, initials)
}

export function approveGate(id, stepIndex, notes, actor = 'You') {
  const it = getItem(id)
  if (!it) return { error: 'not_found' }
  if (disabledProject(it)) return { error: 'project_not_active' }
  if (isClosed(it) || isAbandoned(it) || STEPS[it.cursor].kind !== 'gate') return { error: 'not_at_gate' }
  if (stepIndex !== it.cursor) return { error: 'stale_step' }

  const trimmed = (notes || '').trim()
  db.prepare(`UPDATE work_item SET cursor = cursor + 1, rejected = 0, ${touch} WHERE id = ?`).run(id)
  db.prepare('INSERT INTO gate_decision (item_id, step_index, decision, notes, decided_by) VALUES (?, ?, ?, ?, ?)').run(
    id,
    stepIndex,
    'approved',
    trimmed,
    actor,
  )
  if (trimmed) {
    // Approval notes are direction for whoever runs next — queue as feedback
    // so the next dispatched agent step receives and must address them.
    db.prepare('INSERT INTO feedback (item_id, target, message) VALUES (?, ?, ?)').run(
      id,
      STEPS[stepIndex + 1]?.agent || '',
      trimmed,
    )
  }
  addEvent(id, {
    who: actor,
    text: `approved: ${STEPS[stepIndex].label.toLowerCase()}${trimmed ? ' — ' + trimmed : ''}`,
    color: '#5E4380',
    initials: '✓',
  })
  notify()
  agentRunner.kick(id)
  const closed = isClosed(getItem(id))
  if (closed) wakeDependents(id)
  return { ok: true, closed }
}

// Rejection is not a dead end: the item rolls back to the agent step whose
// work was judged, the feedback is queued for that agent, and the orchestrator
// re-runs it (attempt N+1) before returning to the gate.
//
// targetStepIndex lets a human pick a specific earlier agent step instead of
// the nearest-preceding one (HZ-51). It is validated here, server-side,
// before any side effect: only legal from a gate, and only to an agent step
// strictly earlier than that gate — an attacker or a bug can't move an item
// forward or onto another gate. Walking back to an earlier index still means
// every gate between it and here is crossed again on the way forward, so no
// checkpoint is skipped. Omitting it reproduces today's exact behavior,
// including the Accept-gate exception.
export function requestChanges(id, target, feedbackText, actor = 'You', targetStepIndex = null) {
  const it = getItem(id)
  if (!it) return { error: 'not_found' }
  if (disabledProject(it)) return { error: 'project_not_active' }
  if (isClosed(it)) return { error: 'closed' }
  if (isAbandoned(it)) return { error: 'abandoned' }

  if (targetStepIndex != null) {
    const atGate = STEPS[it.cursor]?.kind === 'gate'
    const validTarget =
      Number.isInteger(targetStepIndex) &&
      targetStepIndex >= 0 &&
      targetStepIndex < it.cursor &&
      STEPS[targetStepIndex]?.kind === 'agent'
    if (!atGate || !validTarget) return { error: 'invalid_target' }
  }

  agentRunner.cancel(id, 'rejected')

  let reworkIdx = it.cursor
  if (STEPS[it.cursor]?.kind === 'gate') {
    db.prepare('INSERT INTO gate_decision (item_id, step_index, decision, notes, decided_by) VALUES (?, ?, ?, ?, ?)').run(
      id,
      it.cursor,
      'rejected',
      feedbackText || '',
      actor,
    )
    if (targetStepIndex != null) {
      reworkIdx = targetStepIndex
    } else if (it.cursor === ACCEPT_GATE_INDEX) {
      // The automated Review step immediately precedes this gate, but
      // rejecting the code means the CODE is wrong — walking back to the
      // nearest agent step would land on Review, which would just re-judge
      // the same unchanged diff. Send the human's rejection to Eng instead.
      reworkIdx = IMPLEMENT_STEP_INDEX
    } else {
      while (reworkIdx > 0 && STEPS[reworkIdx].kind !== 'agent') reworkIdx--
    }
  }
  const reworkAgent = STEPS[reworkIdx].kind === 'agent' ? STEPS[reworkIdx].agent : null

  db.prepare('INSERT INTO feedback (item_id, target, message) VALUES (?, ?, ?)').run(
    id,
    reworkAgent || target || '',
    feedbackText || '(no notes)',
  )
  // A human-directed rework gets a fresh set of automated review cycles —
  // otherwise a prior automated cap-out could falsely cap this new attempt.
  const resetReview = reworkIdx <= IMPLEMENT_STEP_INDEX ? RESET_REVIEW_STATE : ''
  // HZ-346: a human send-back is never held by a rule block.
  db.prepare(
    `UPDATE work_item SET cursor = ?, rejected = 0, paused = 0, rule_block_json = NULL${resetReview}, ${touch} WHERE id = ?`,
  ).run(reworkIdx, id)
  addEvent(id, {
    who: actor,
    text: `requested changes on ${target || 'this step'}${feedbackText ? ': ' + feedbackText : ''} — sent back to the ${STEPS[reworkIdx].label.toLowerCase()} step`,
    color: '#9C333E',
    initials: 'YOU',
  })
  notify()
  agentRunner.kick(id)
  return { ok: true }
}

export function setPaused(id, paused) {
  const it = getItem(id)
  if (!it) return { error: 'not_found' }
  if (disabledProject(it)) return { error: 'project_not_active' }
  if (isClosed(it)) return { error: 'closed' }
  if (isAbandoned(it)) return { error: 'abandoned' }

  // HZ-346: Resume is the owner's retry for a rule-blocked item, so it clears
  // the block; Pause leaves it.
  const unblock = paused ? '' : 'rule_block_json = NULL, '
  db.prepare(`UPDATE work_item SET paused = ?, ${unblock}${touch} WHERE id = ?`).run(paused ? 1 : 0, id)
  addEvent(id, {
    who: 'You',
    text: paused ? 'paused agent work on this item' : 'resumed work',
    color: '#5E4380',
    initials: 'YOU',
  })
  notify()
  // HZ-194: pause, not cancel — a running attempt checkpoints its work first.
  if (paused) agentRunner.pause(id)
  else agentRunner.kick(id)
  return { ok: true }
}

// The human leg of specialist routing: confirm or override the persona the PM
// proposed (usually at the intake gate; the next dispatch reads the item).
//
// One slot per agent (HZ-125): setting the QA persona leaves the Eng one alone,
// so the write merges rather than replaces. Because `it.personas` already came
// through personasFromRow, the first call on a pre-HZ-125 item carries its
// translated legacy value into personas_json instead of dropping it.
export function setPersona(id, agent, persona) {
  const it = getItem(id)
  if (!it) return { error: 'not_found' }
  if (disabledProject(it)) return { error: 'project_not_active' }
  if (isClosed(it)) return { error: 'closed' }
  if (isAbandoned(it)) return { error: 'abandoned' }
  if (!isPersona(agent, persona)) return { error: 'bad_persona' }

  const merged = { ...it.personas, [agent]: persona }
  db.prepare(`UPDATE work_item SET personas_json = ?, ${touch} WHERE id = ?`).run(JSON.stringify(merged), id)
  addEvent(id, {
    who: 'You',
    text: `set the ${agent} specialist persona to ${personaLabel(agent, persona)}`,
    color: '#5E4380',
    initials: 'YOU',
  })
  notify()
  return { ok: true }
}

// Priority changes arrive from the UI or the WhatsApp concierge; either way
// it is the human speaking. GitHub label mirroring lives in the route (best
// effort) — this only owns the database and the activity trail.
//
// HZ-135 deleted the `export const PRIORITIES` that stood here. The vocabulary
// is domain/priorities.json's; its one caller (the POST /api/items/:id/priority
// body enum in app.js) now reads the binding directly, so there is no re-export
// to keep in step.
export function setPriority(id, priority) {
  const it = getItem(id)
  if (!it) return { error: 'not_found' }
  if (disabledProject(it)) return { error: 'project_not_active' }
  if (isClosed(it)) return { error: 'closed' }
  if (isAbandoned(it)) return { error: 'abandoned' }
  if (!isPriority(priority)) return { error: 'bad_priority' }
  if (it.priority === priority) return { ok: true, unchanged: true }

  db.prepare(`UPDATE work_item SET priority = ?, ${touch} WHERE id = ?`).run(priority, id)
  addEvent(id, {
    who: 'You',
    text: `set the priority to ${priority} (was ${it.priority})`,
    color: '#5E4380',
    initials: 'YOU',
  })
  notify()
  return { ok: true }
}

export function restartPhase(id, phase, reason, actor = 'You') {
  const it = getItem(id)
  if (!it) return { error: 'not_found' }
  if (disabledProject(it)) return { error: 'project_not_active' }
  // Abandonment must not be silently undone by a lever that predates it —
  // reopening an abandoned item is a deliberate act this function doesn't own.
  if (isAbandoned(it)) return { error: 'abandoned' }
  const firstIdx = STEPS.findIndex((st) => st.phase === phase)
  if (firstIdx < 0) return { error: 'bad_phase' }

  agentRunner.cancel(id, 'superseded')
  if (reason) {
    // The restart reason is feedback: the first re-run agent must address it.
    db.prepare('INSERT INTO feedback (item_id, target, message) VALUES (?, ?, ?)').run(
      id,
      STEPS[firstIdx].agent || '',
      reason,
    )
  }
  const resetReview = firstIdx <= IMPLEMENT_STEP_INDEX ? RESET_REVIEW_STATE : ''
  // HZ-346: a restart moves the cursor, so a rule block must not hold it.
  db.prepare(
    `UPDATE work_item SET cursor = ?, rejected = 0, paused = 0, rule_block_json = NULL${resetReview}, ${touch} WHERE id = ?`,
  ).run(firstIdx, id)
  addEvent(id, {
    who: actor,
    text: `restarted the ${PHASES[phase]} phase${reason ? ': ' + reason : ''}`,
    color: '#DFA200',
    initials: 'YOU',
  })
  notify()
  agentRunner.kick(id)
  return { ok: true }
}

// Soft delete (HZ-59): a human stops a work item that should not proceed.
// Dropping work is at least as consequential as approving it, so the route
// gates this behind the same human gate PIN as gate approval — see app.js.
// DB write + run cancellation happen here, BEFORE the route's best-effort
// GitHub close: closing the issue fires Horizon's own issues.closed webhook
// back at itself, and upsertFromGithub must see abandoned_at already set or
// it would race to reclassify this item as completed instead.
//
// HZ-354: removeDependentLinks also drops every link where this item is the
// blocker, in the same transaction as the abandon — both land or neither
// does. Only those edges go: this item's own "blocked by" links and every
// dependent row stay as they are. Each unlinked dependent gets one event
// naming this item, closed or abandoned dependents included.
export function abandonItem(id, reason, actor = 'You', { removeDependentLinks = false } = {}) {
  const it = getItem(id)
  if (!it) return { error: 'not_found' }
  if (disabledProject(it)) return { error: 'project_not_active' }
  if (isClosed(it)) return { error: 'closed' }
  if (isAbandoned(it)) return { error: 'already_abandoned' }
  const trimmed = (reason || '').trim()
  if (!trimmed) return { error: 'reason_required' }

  // Stop dispatch first: a superseded/cancelled run must not keep burning a
  // farm concurrency slot on work that's about to be marked abandoned.
  agentRunner.cancel(id, 'cancelled')
  const removedLinks = db.transaction(() => {
    db.prepare(
      `UPDATE work_item SET abandoned_at = datetime('now'), abandoned_reason = ?, abandoned_by = ?, ${touch} WHERE id = ?`,
    ).run(trimmed, actor, id)
    addEvent(id, { who: actor, text: `abandoned this item: ${trimmed}`, color: '#9C333E', initials: 'YOU' })
    if (!removeDependentLinks) {
      // HZ-78: a dependent can never wait this blocker out — surface it on every
      // live dependent instead of leaving it silently stuck (see escalateDependents).
      escalateDependents(id, actor)
      return []
    }
    const dependentIds = selectDependentIds.all(id).map((row) => row.item_id)
    db.prepare('DELETE FROM work_item_dependency WHERE depends_on_id = ?').run(id)
    for (const depId of dependentIds) {
      addEvent(depId, {
        who: actor,
        text: `removed the dependency on ${id} (${it.title}): it was abandoned`,
        color: '#5E4380',
        initials: 'YOU',
      })
    }
    return dependentIds
  })()
  notify()
  if (!removeDependentLinks) return { ok: true }
  // Same as removeDependency: a dependent whose last open blocker just went
  // is runnable again and must start without waiting for another trigger.
  for (const depId of removedLinks) agentRunner.kick(depId)
  return { ok: true, removedLinks }
}

// Standalone feedback (UI form or an ingested GitHub comment). If the item is
// sitting on an agent step and not paused, the in-flight run is superseded and
// the step re-runs (attempt N+1) with this feedback injected; otherwise the
// row waits (delivered_at NULL) for the next dispatch — dispatchToFarm picks
// up all undelivered rows. Rejection feedback still flows via requestChanges.
export function addFeedback(id, { message, target = '', source = 'ui', ghCommentId = null }) {
  const it = getItem(id)
  if (!it) return { error: 'not_found' }
  if (disabledProject(it)) return { error: 'project_not_active' }
  if (isClosed(it)) return { error: 'closed' }
  if (isAbandoned(it)) return { error: 'abandoned' }

  if (ghCommentId != null) {
    const seen = db.prepare('SELECT id FROM feedback WHERE gh_comment_id = ?').get(ghCommentId)
    if (seen) return { ok: true, duplicate: true }
  }

  const text = String(message || '').trim().slice(0, 2000)
  if (!text) return { error: 'empty_message' }
  const step = STEPS[it.cursor]
  db.prepare('INSERT INTO feedback (item_id, target, message, source, gh_comment_id) VALUES (?, ?, ?, ?, ?)').run(
    id,
    target || (step?.kind === 'agent' ? step.agent : ''),
    text,
    source,
    ghCommentId,
  )
  const fromGithub = source === 'github'
  addEvent(id, {
    who: fromGithub ? 'GitHub' : 'You',
    text: `left feedback: ${text.slice(0, 200)}`,
    color: fromGithub ? '#2A2A2E' : '#5E4380',
    initials: fromGithub ? 'GH' : 'YOU',
  })

  if (step?.kind === 'agent' && !it.paused) {
    // Supersede the current attempt so the agent re-runs with the feedback.
    agentRunner.cancel(id, 'superseded')
    notify()
    agentRunner.kick(id)
    return { ok: true, rerun: true }
  }
  notify()
  return { ok: true, queued: true }
}

// HZ-236: queues a message for the item's next agent dispatch, once. Unlike
// addFeedback it never cancels or re-kicks anything — step 9's overlap check
// writes onto OTHER items, whose running steps must not be touched — and a
// message already on the item (delivered or not) is not queued again, so
// re-running step 9 never leaves a second copy.
export function queueFeedbackOnce(id, { message, target = 'Eng', source = 'overlap' }) {
  if (!getItem(id)) return { error: 'not_found' }
  const text = String(message || '').trim().slice(0, 2000)
  if (!text) return { error: 'empty_message' }
  if (db.prepare('SELECT 1 FROM feedback WHERE item_id = ? AND message = ?').get(id, text)) return { ok: true, duplicate: true }
  db.prepare('INSERT INTO feedback (item_id, target, message, source) VALUES (?, ?, ?, ?)').run(id, target, text, source)
  addEvent(id, { who: 'Horizon', text: `queued feedback for the next agent step: ${text.slice(0, 200)}`, color: '#5E4380', initials: 'HZ' })
  notify()
  return { ok: true, queued: true }
}

// Remove the BF-* demo items (called when real GitHub sync is connected).
export function purgeDemoItems() {
  const ids = db.prepare("SELECT id FROM work_item WHERE id LIKE 'BF-%'").all().map((r) => r.id)
  if (ids.length === 0) return
  ids.forEach((id) => agentRunner.cancel(id, 'cancelled'))
  db.transaction(() => {
    // gate_notice is deliberately absent: it declares ON DELETE CASCADE (see
    // db.js), so it clears with the work_item row below. Every table named here
    // does not, and foreign_keys = ON makes a forgotten one an FK error.
    for (const table of ['event', 'gate_decision', 'feedback', 'step_run']) {
      db.prepare(`DELETE FROM ${table} WHERE item_id LIKE 'BF-%'`).run()
    }
    db.prepare("DELETE FROM work_item WHERE id LIKE 'BF-%'").run()
  })()
  notify()
}

// ---- issue body <-> structured fields ----
// Inverse of composeIssueBody in github.js: lifts "## Outcome", "## Success
// metric" and "## Guardrails" sections out of an issue body. Bodies without
// those headings land wholesale in desc.

export function parseIssueBody(body) {
  const text = (body || '').replace(/\r\n/g, '\n').trim()
  const result = { desc: '', metric: '', guardrails: '' }
  if (!text) return result

  const KEYS = { outcome: 'desc', 'success metric': 'metric', guardrails: 'guardrails' }
  const parts = text.split(/^##\s+/m)
  const preamble = parts.shift().trim()
  for (const part of parts) {
    const newline = part.indexOf('\n')
    const heading = (newline === -1 ? part : part.slice(0, newline)).trim().toLowerCase()
    const content = (newline === -1 ? '' : part.slice(newline + 1)).trim()
    const key = KEYS[heading]
    if (key && content) result[key] = content
  }
  if (!result.desc) result.desc = preamble || text
  return result
}

// The item synced from this repo's issue, or null.
export function findItemByIssue(repoFullName, issue) {
  const row = db.prepare('SELECT id FROM work_item WHERE repo = ? AND issue = ?').get(repoFullName, issue)
  return row ? getItem(row.id) : null
}

// HZ-313: after a split is filed, the source item's description and metric
// cover only its own repo. Its only caller is split.js, which has already
// pushed the same text to the item's GitHub issue, so a later sync reads it back.
export function applySplitScope(id, { desc, metric }, actor = 'Horizon') {
  const it = getItem(id)
  if (!it) return { error: 'not_found' }
  db.prepare(`UPDATE work_item SET desc = ?, metric = ?, ${touch} WHERE id = ?`).run(desc ?? it.desc, metric ?? it.metric, id)
  addEvent(id, {
    who: actor,
    text: 'narrowed this item’s description and success metric to its own repo after the split',
    color: '#5E4380',
    initials: 'HZ',
  })
  notify()
  return { ok: true }
}

// ---- local (demo-mode) item creation ----

export function createLocalItem({ title, outcome, metric, guardrails, priority }) {
  const next =
    db
      .prepare("SELECT COALESCE(MAX(CAST(SUBSTR(id, 5) AS INTEGER)), 0) AS n FROM work_item WHERE id LIKE 'LOC-%'")
      .get().n + 1
  const id = `LOC-${next}`
  db.prepare(
    'INSERT INTO work_item (id, title, priority, desc, metric, guardrails, cursor) VALUES (?, ?, ?, ?, ?, ?, 0)',
  ).run(id, title, priority, outcome, metric, guardrails || '')
  addEvent(id, { who: 'You', text: 'created this work item', color: '#5E4380', initials: 'YOU' })
  notify()
  agentRunner.kick(id)
  return id
}

// GitHub is allowed to decide the "Accept the code" gate: merging the item's
// PR there is the same human approval, just expressed on the other surface.
export function approveGateFromGithub(id) {
  const it = getItem(id)
  if (!it) return { error: 'not_found' }
  const stepIndex = it.cursor
  if (isClosed(it) || isAbandoned(it) || STEPS[stepIndex]?.label !== 'Accept the code') return { error: 'not_at_accept_gate' }

  db.prepare(`UPDATE work_item SET cursor = cursor + 1, rejected = 0, ${touch} WHERE id = ?`).run(id)
  db.prepare(
    "INSERT INTO gate_decision (item_id, step_index, decision, decided_by) VALUES (?, ?, 'approved', 'GitHub')",
  ).run(id, stepIndex)
  addEvent(id, {
    who: 'GitHub',
    text: `PR #${it.pr} was merged on GitHub — code accepted`,
    color: '#2A2A2E',
    initials: 'GH',
  })
  notify()
  agentRunner.kick(id)
  if (isClosed(getItem(id))) wakeDependents(id)
  return { ok: true }
}

// ---- GitHub sync ----
// Shared upsert used by both the webhook handler and the poller. GitHub owns
// title/description/priority/open-closed; the lifecycle state (cursor, flags,
// metric, guardrails) stays ours and is never clobbered by a sync.

// priorityFromLabels moved to server/src/priorityLabels.js in HZ-135, alongside
// the label NAME format that has to match it and the pattern github.js had
// hand-typed a second, byte-identical copy of. Label syntax is not persistence.
export function upsertFromGithub(ghIssue, repoFullName) {
  if (!ghIssue || ghIssue.pull_request) return false // /issues endpoints include PRs
  const repoRow = findRepo(repoFullName)
  if (!repoRow) return false // not a connected repo

  const number = ghIssue.number
  const title = ghIssue.title || `Issue #${number}`
  const { desc, metric, guardrails } = parseIssueBody(ghIssue.body)
  const priority = priorityFromLabels(ghIssue.labels)
  const closedOnGithub = ghIssue.state === 'closed'
  const row = db.prepare('SELECT * FROM work_item WHERE repo = ? AND issue = ?').get(repoFullName, number)
  let changed = false

  if (!row) {
    const id = `${repoRow.prefix}-${number}`
    db.prepare(
      'INSERT INTO work_item (id, title, priority, desc, metric, guardrails, issue, repo, project_id, cursor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, title, priority, desc, metric, guardrails, number, repoFullName, repoRow.project_id, closedOnGithub ? STEPS.length : 0)
    addEvent(id, { who: 'GitHub', text: `opened issue #${number}`, color: '#2A2A2E', initials: 'GH' })
    changed = true
    if (!closedOnGithub) agentRunner.kick(id)
  } else {
    // Structured sections only overwrite when the body actually carries them,
    // so agent-refined metric/guardrails survive issues edited without those headings.
    const newMetric = metric || row.metric
    const newGuardrails = guardrails || row.guardrails
    if (title !== row.title || desc !== row.desc || priority !== row.priority || newMetric !== row.metric || newGuardrails !== row.guardrails) {
      db.prepare(
        `UPDATE work_item SET title = ?, desc = ?, priority = ?, metric = ?, guardrails = ?, ${touch} WHERE id = ?`,
      ).run(title, desc, priority, newMetric, newGuardrails, row.id)
      changed = true
    }
    const wasClosed = row.cursor >= STEPS.length
    // Both branches skip an already-abandoned item: closing the issue is
    // abandonItem's own best-effort side effect (would otherwise race to
    // reclassify the item as completed — see abandonItem above), and a
    // GitHub reopen must never silently resurrect an abandoned item mid-flight.
    if (closedOnGithub && !wasClosed && !row.abandoned_at) {
      agentRunner.cancel(row.id, 'cancelled')
      db.prepare(`UPDATE work_item SET cursor = ?, ${touch} WHERE id = ?`).run(STEPS.length, row.id)
      addEvent(row.id, { who: 'GitHub', text: `closed issue #${number}`, color: '#2A2A2E', initials: 'GH' })
      changed = true
      wakeDependents(row.id)
    } else if (!closedOnGithub && wasClosed && !row.abandoned_at) {
      db.prepare(`UPDATE work_item SET cursor = 0, rejected = 0, paused = 0, ${touch} WHERE id = ?`).run(row.id)
      addEvent(row.id, { who: 'GitHub', text: `reopened issue #${number}`, color: '#2A2A2E', initials: 'GH' })
      changed = true
      agentRunner.kick(row.id)
    }
  }

  if (changed) notify()
  return changed
}

// One-time boot recovery: items frozen in the legacy "rejected" state (from
// before rejection triggered rework) are requeued at the responsible agent
// step, reusing the rejection notes as the agent's feedback.
export function recoverRejectedItems() {
  const rows = db.prepare('SELECT id, cursor FROM work_item WHERE rejected = 1').all()
  for (const row of rows) {
    let reworkIdx = Math.min(row.cursor, STEPS.length - 1)
    if (STEPS[reworkIdx].kind === 'gate') {
      // Same Accept-gate special case as requestChanges: don't land on the
      // automated Review step, which would just re-judge unchanged code.
      if (reworkIdx === ACCEPT_GATE_INDEX) {
        reworkIdx = IMPLEMENT_STEP_INDEX
      } else {
        while (reworkIdx > 0 && STEPS[reworkIdx].kind !== 'agent') reworkIdx--
      }
    }
    const notes = db
      .prepare("SELECT notes FROM gate_decision WHERE item_id = ? AND decision = 'rejected' ORDER BY id DESC LIMIT 1")
      .get(row.id)?.notes
    db.prepare('INSERT INTO feedback (item_id, target, message) VALUES (?, ?, ?)').run(
      row.id,
      STEPS[reworkIdx].agent || '',
      notes || 'changes requested',
    )
    const resetReview = reworkIdx <= IMPLEMENT_STEP_INDEX ? RESET_REVIEW_STATE : ''
    db.prepare(`UPDATE work_item SET cursor = ?, rejected = 0${resetReview}, ${touch} WHERE id = ?`).run(reworkIdx, row.id)
    addEvent(row.id, {
      who: 'Horizon',
      text: `requeued for rework at “${STEPS[reworkIdx].label}”`,
      color: '#8C8C8E',
      initials: 'HZ',
    })
    agentRunner.kick(row.id)
  }
  if (rows.length > 0) notify()
  return rows.length
}

// Agent-step execution lives in orchestrator.js (registered via
// registerAgentRunner at server startup).
