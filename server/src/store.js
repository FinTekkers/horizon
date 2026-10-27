// Domain operations over SQLite. Every mutation notifies subscribers so the
// HTTP layer can push fresh state to SSE clients.

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { db } from './db.js'
import { GATE_ACTION_MARGIN_MS, PREMERGE_SKIP_MAX_AGE_MS } from './config.js'
import {
  STEPS,
  isClosed,
  isAbandoned,
  isBlockedByAbandoned,
  isImplementBlocked,
  holdingBlockers,
  curStep,
  IMPLEMENT_STEP_INDEX,
  REVIEW_STEP_INDEX,
  ACCEPT_GATE_INDEX,
  DEPLOY_STEP_INDEX,
  agentStepIndexes,
  isItemKind,
  itemKindOf,
  phasesFor,
  stepsFor,
  firstStepIndex,
  endIndex,
  isHumanOnlyGate,
  isServerStep,
  RUN_PLAN_STEP_INDEX,
  APPROVE_RUN_GATE_INDEX,
  EXECUTE_STEP_INDEX,
  gateStepIndexes,
  laneOf,
  laneSkips,
  nextCursor,
} from '../../domain/js/lifecycle.js'
import { isPriority } from '../../domain/js/priorities.js'
import { choiceLabel, choiceValues, parseChoice, providerNames } from '../../domain/js/providers.js'
import { REASON } from '../../domain/js/reasons.js'
import { effectiveRunner, extractRunPlan } from '../../domain/js/runPlan.js'
import { isHumanProof } from './humanProof.js'
import { isPersona, personaDisplay, personaLabel, personasFromRow } from './personas.js'
import { priorityFromLabels } from './priorityLabels.js'
import { kindFromLabels, laneFromLabels } from './kindLabels.js'
import { AUTOPILOT_OFF_LABEL, autopilotOffFromLabels } from './autopilotOffLabel.js'
import { getActiveProjectId, setSetting } from './settings.js'
import { parseRuleBlock } from './ruleBlock.js'
import { fallbackNoteText, usageWaitText } from './usageLimits.js'
import { msOf, sqlTime } from './sqlTime.js'
import { findTargetByRepo } from './deployTargets.js'

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

// HZ-481: the orchestrator registers the deploy drain's read side here at
// init (deployDrain.js imports this module, so importing it back would be a
// cycle): block(now) is deployDrain.deployBlock, survives(stepIndex) is
// deployDrain.survivesRestart. Until then (mock mode, tests without init())
// there is no drain to show.
let deployDrainProvider = { block: () => null, survives: () => false }

export function registerDeployDrainProvider(provider) {
  deployDrainProvider = { ...deployDrainProvider, ...provider }
}

// HZ-535: the orchestrator registers definitions.js's projectPersonaOverlay
// here when it loads. store.js never imports definitions.js itself, so the
// WhatsApp vote path (waPollVotes.js -> store.js) still cannot reach it
// (wa-poll-no-model.test.mjs). Until then every item reads the global
// personas, exactly as a project with no definitions does.
let projectOverlayLoader = () => null

export function registerProjectOverlayLoader(loader) {
  projectOverlayLoader = loader
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
// HZ-378: job-lane rows are left out too — a deploy never waits for, lists,
// kills or cancels a job; the job outlives the drain and reports after it.
export function listRunningAgentSteps() {
  return db
    .prepare("SELECT id, item_id, step_index, started_at FROM step_run WHERE status = 'active' AND step_index != ? ORDER BY id")
    .all(DEPLOY_STEP_INDEX)
    .filter((row) => STEPS[row.step_index]?.runsIn !== 'job')
    .map((row) => ({ runId: row.id, itemId: row.item_id, stepIndex: row.step_index, step: stepSlug(row.step_index), startedAt: row.started_at }))
}

// HZ-378: the item's active Execute run, if any — the job Stop and Resume
// act on. Reads the active step_run at the Execute index; no other step's
// run is ever a job.
export function activeJobRun(itemId) {
  return (
    db
      .prepare("SELECT id, item_id, step_index, attempt, started_at FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'active' ORDER BY id DESC LIMIT 1")
      .get(itemId, EXECUTE_STEP_INDEX) ?? null
  )
}

// HZ-407: the item's newest Execute run in any status — whose log the
// card's Full log link serves, including after Stop.
export function latestJobRun(itemId) {
  return (
    db
      .prepare('SELECT id, item_id, step_index, attempt, status FROM step_run WHERE item_id = ? AND step_index = ? ORDER BY id DESC LIMIT 1')
      .get(itemId, EXECUTE_STEP_INDEX) ?? null
  )
}

// HZ-408: every active Execute run of an item in `repo` — what holds a deploy
// of that repo (server/src/deployHold.js). startedMs is when the farm
// confirmed the runner launched, else the dispatch; budgetMs is the run
// plan's budget, or null when the plan is unreadable.
export function runningJobsIn(repo) {
  return db
    .prepare(
      `SELECT r.id, r.item_id, COALESCE(r.agent_started_at, r.started_at) AS started_at
         FROM step_run r JOIN work_item w ON w.id = r.item_id
        WHERE w.repo = ? AND r.step_index = ? AND r.status = 'active' ORDER BY r.id`,
    )
    .all(repo, EXECUTE_STEP_INDEX)
    .map((row) => {
      const minutes = currentRunPlan(row.item_id)?.block.budget_minutes
      return { runId: row.id, itemId: row.item_id, startedMs: msOf(row.started_at), budgetMs: minutes ? minutes * 60000 : null }
    })
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

// HZ-406: whether the item's newest branch run (its own changed
// scripts/checks/, see farm/checks.py) failed. That run is the one holding the
// item's highest branch test_result id; it is stale, so false, once a main
// run was stored after it (a later attempt that changed no check script). In
// it, each command's last attempt decides: it failed if any of its rows is a
// fail or did not exit 0. A run that timed out, crashed or never started
// stores a fail row with no exit code, so it reads as failed too (fail
// closed). Rows stored before HZ-406, when a branch failure was evidence
// only, are read the same way. May throw; app.js treats a throw as "run
// pre-merge".
export function latestBranchRunFailed(itemId) {
  const branch = db
    .prepare(
      `SELECT id, check_run FROM test_result WHERE item_id = ? AND run_label = 'branch' ORDER BY id DESC LIMIT 1`,
    )
    .get(itemId)
  if (!branch) return false
  const main = db
    .prepare(`SELECT MAX(id) AS id FROM test_result WHERE item_id = ? AND run_label = 'main'`)
    .get(itemId)
  if (main?.id != null && main.id > branch.id) return false
  const failed = db
    .prepare(
      `SELECT 1 FROM test_result t
       WHERE t.check_run = ?
         AND t.attempt = (SELECT MAX(u.attempt) FROM test_result u WHERE u.check_run = t.check_run AND u.command = t.command)
         AND (t.status = 'fail' OR t.exit_code IS NULL OR t.exit_code != 0)
       LIMIT 1`,
    )
    .get(branch.check_run)
  return !!failed
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

// `checks` (HZ-245) adds each repo's check commands, (HZ-304) its
// 'no checks' / 'no deploy' marks and (HZ-425) its default branch; off for
// consumers with no use for them.
export function listProjects({ checks = true } = {}) {
  const projects = db.prepare('SELECT * FROM project ORDER BY name').all()
  const repos = db.prepare('SELECT * FROM project_repo ORDER BY repo').all()
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    enabled: !!p.enabled,
    autopilot: p.autopilot,
    autopilotEvents: selectAutopilotEvents.all(p.id),
    // HZ-535: the PIN-gated switch for the project's own definitions.
    definitionsEnabled: !!p.definitions_enabled,
    providerDefaults: providerDefaultsFromRow(p),
    repos: repos
      .filter((r) => r.project_id === p.id)
      .map((r) => ({
        repo: r.repo,
        prefix: r.prefix,
        ...(checks
          ? {
              checks: repoChecks(r),
              marks: repoMarks(r),
              defaultBranch: r.default_branch ?? null,
              // HZ-494: the path only — the server never opens the file.
              testEnvFile: r.test_env_file ?? null,
            }
          : {}),
      })),
  }))
}

// ---- per-repo check commands (HZ-245) ----
// The commands farm/checks.py runs for a repo, one slot each, in this order.
// A human sets them in Admin; NULL everywhere means "not configured" — HZ-304:
// the repo's implement fails until they are set or it is marked 'no checks'.
// HZ-505: `screenshots` comes last and never counts as configured on its own.

export const SCREENSHOTS_SLOT = 'screenshots'
export const CHECK_SLOTS = ['install', 'test', 'lint', 'e2e', SCREENSHOTS_SLOT]

function repoChecks(row) {
  return Object.fromEntries(CHECK_SLOTS.map((slot) => [slot, row[`check_${slot}`] ?? null]))
}

// What the farm is sent with a task: the stored slots, or null when the repo
// is unknown or has nothing configured (the caller then sends nothing). A
// screenshots command alone is not a check suite, so it counts as nothing.
export function getRepoCheckCommands(repoFullName) {
  const row = repoFullName ? findRepo(repoFullName) : null
  if (!row) return null
  const checks = repoChecks(row)
  return CHECK_SLOTS.some((slot) => slot !== SCREENSHOTS_SLOT && checks[slot] != null) ? checks : null
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
    'UPDATE project_repo SET check_install = ?, check_test = ?, check_lint = ?, check_e2e = ?, check_screenshots = ? WHERE id = ?',
  ).run(...values, row.id)
  notify()
  return { ok: true, checks: Object.fromEntries(CHECK_SLOTS.map((slot, i) => [slot, values[i]])) }
}

// ---- per-repo test-login env file (HZ-494) ----
// The host path of a file of NAME=value lines (e.g. /etc/fintekkers/ui-e2e.env)
// that the farm loads into this repo's test/e2e checks and deploy smoke check
// at run time. Only the path is stored, sent or shown; the server never reads
// the file, so no value can reach the DB, GitHub, the UI or a prompt.

export const TEST_ENV_FILE_MAX_CHARS = 500

// What the farm is sent with a task or premerge run, or null.
export function getRepoTestEnvFile(repoFullName) {
  const row = repoFullName ? findRepo(repoFullName) : null
  return row?.test_env_file ?? null
}

// Where the file may never live: the farm's state and workspaces, which an
// agent can read, commit or publish. Mirrors farm/login_env.py, which checks
// again at load time.
function farmHome() {
  return path.resolve(process.env.FARM_HOME || path.join(os.homedir(), '.horizon-farm'))
}

function within(child, root) {
  const rel = path.relative(root, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// A symlink is followed when the server can resolve it — a dangling one too,
// since the file may not exist yet. Resolving reads directory entries and
// links only, never the file. Unresolvable: the literal path.
function resolvedPath(p, depth = 0) {
  try {
    return fs.realpathSync(p)
  } catch {
    // fall through: missing, dangling or unreadable
  }
  try {
    if (depth < 8 && fs.lstatSync(p).isSymbolicLink()) {
      return resolvedPath(path.resolve(path.dirname(p), fs.readlinkSync(p)), depth + 1)
    }
  } catch {
    // fall through
  }
  try {
    return path.join(fs.realpathSync(path.dirname(p)), path.basename(p))
  } catch {
    return p
  }
}

// null when `value` is a storable path, else the 400 message.
export function testEnvFileError(value) {
  if (typeof value !== 'string' || value.length > TEST_ENV_FILE_MAX_CHARS || /[\0\r\n]/.test(value)) {
    return `Path must be an absolute file path of at most ${TEST_ENV_FILE_MAX_CHARS} characters`
  }
  if (!path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value.endsWith('/')) {
    return 'Path must be absolute and normalised'
  }
  const roots = [farmHome(), path.join(farmHome(), 'workspaces')]
  if ([value, resolvedPath(value)].some((p) => roots.some((root) => within(p, root)))) {
    return "Path must be outside the farm's state and workspaces"
  }
  return null
}

// The ONLY writer of test_env_file, and its only caller is the PIN-gated
// Admin route in app.js, like setRepoCheckCommands. Blank clears it.
export function setRepoTestEnvFile(projectId, repoFullName, value) {
  const row = db.prepare('SELECT id FROM project_repo WHERE project_id = ? AND repo = ?').get(projectId, repoFullName)
  if (!row) return { error: 'not_found' }
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed) {
    const invalid = testEnvFileError(trimmed)
    if (invalid) return { error: 'invalid', message: invalid }
  }
  const stored = trimmed || null
  db.prepare('UPDATE project_repo SET test_env_file = ? WHERE id = ?').run(stored, row.id)
  notify()
  return { ok: true, testEnvFile: stored }
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

// ---- HZ-447: a Plan's repo scope ----

export function setScopeRepos(itemId, repos) {
  db.prepare('UPDATE work_item SET scope_repos_json = ? WHERE id = ?').run(JSON.stringify(repos), itemId)
}

// The newest check pass recorded for any item in the repo. check_pass keeps
// passes only, pruned after CHECK_PASS_KEEP_MS, so 'none' can also mean the
// last pass was pruned.
export function latestCheckPass(repo) {
  const row = db
    .prepare('SELECT sha, finished_at, source FROM check_pass WHERE repo = ? ORDER BY finished_at DESC LIMIT 1')
    .get(repo)
  return row ? { status: 'pass', sha: row.sha, finished_at: row.finished_at, source: row.source } : { status: 'none' }
}

// { repos, outOfScope } for a Plan: the stored scope's repos within the
// item's project — every project repo when none is stored — plus the item's
// own repo, so its prompt never names a repo the Plan cannot read. Every
// other connected repo is out of scope: the farm masks those, never reads them.
export function getPlanScope(itemId) {
  const item = db.prepare('SELECT repo, project_id, scope_repos_json FROM work_item WHERE id = ?').get(itemId)
  let chosen = null
  try {
    chosen = item?.scope_repos_json ? JSON.parse(item.scope_repos_json) : null
  } catch {
    chosen = null
  }
  const inScope = (r) =>
    r.project_id === item?.project_id && (!Array.isArray(chosen) || chosen.includes(r.repo) || r.repo === item.repo)
  const repos = listRepos()
  return {
    repos: repos
      .filter(inScope)
      .map((r) => ({ repo: r.repo, default_branch: getDefaultBranch(r.repo)?.branch ?? null, last_check: latestCheckPass(r.repo) })),
    outOfScope: repos.filter((r) => !inScope(r)).map((r) => r.repo),
  }
}

export function findRepo(repoFullName) {
  return db.prepare('SELECT * FROM project_repo WHERE repo = ?').get(repoFullName) || null
}

// ---- default branch (HZ-425) ----
// The repo's GitHub default branch as last read: { branch, at } (both null
// when not read yet), or null for a repo that isn't connected. A DB read only.
export function getDefaultBranch(repoFullName) {
  const row = repoFullName
    ? db.prepare('SELECT default_branch, default_branch_at FROM project_repo WHERE repo = ?').get(repoFullName)
    : null
  return row ? { branch: row.default_branch ?? null, at: row.default_branch_at ?? null } : null
}

// Records a read of the repo's default branch at `now`. A no-op returning
// false for an unconnected repo or a value that isn't a branch name.
export function setDefaultBranch(repoFullName, branch, now = Date.now()) {
  if (typeof branch !== 'string' || !branch.trim() || /\s/.test(branch)) return false
  const changed =
    db
      .prepare('UPDATE project_repo SET default_branch = ?, default_branch_at = ? WHERE repo = ?')
      .run(branch, sqlTime(now), repoFullName).changes > 0
  if (changed) notify()
  return changed
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

// HZ-535: the ONLY writer of project.definitions_enabled; its one caller is
// the PIN-gated Admin route. Same shape as setProjectAutopilot: the flag and
// its project_event row land in one transaction, and a same-value write
// records nothing.
export function setProjectDefinitionsEnabled(projectId, enabled, who) {
  const value = enabled ? 1 : 0
  const result = db.transaction(() => {
    const row = db.prepare('SELECT definitions_enabled FROM project WHERE id = ?').get(projectId)
    if (!row) return { error: 'not_found' }
    if (row.definitions_enabled === value) return { ok: true, old: !!value, new: !!value, unchanged: true }
    db.prepare('UPDATE project SET definitions_enabled = ? WHERE id = ?').run(value, projectId)
    db.prepare(
      "INSERT INTO project_event (project_id, kind, old_value, new_value, who) VALUES (?, 'definitions_enabled', ?, ?, ?)",
    ).run(projectId, String(row.definitions_enabled), String(value), who)
    return { ok: true, old: !!row.definitions_enabled, new: !!value }
  })()
  if (result.ok && !result.unchanged) notify()
  return result
}

// HZ-535: the project overlay an item in `projectId` reads its personas
// through — null for no project, the switch off, or no personas.json, which
// leaves every persona lookup on the global registry exactly.
const selectProjectDefinitions = db.prepare('SELECT name, definitions_enabled FROM project WHERE id = ?')
export function projectOverlayFor(projectId) {
  if (projectId == null) return null
  return projectOverlayLoader(selectProjectDefinitions.get(projectId))
}

// HZ-535: { agent: {label, initials, color} } for each slot holding a project
// persona — its badge comes from the project file. {} for an item with none.
function personaBadges(personas, overlay) {
  if (!overlay) return {}
  const badges = {}
  for (const [agent, id] of Object.entries(personas)) {
    if (Object.hasOwn(overlay.display, id)) badges[agent] = personaDisplay(agent, id, overlay)
  }
  return badges
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
const selectEvents = db.prepare(
  'SELECT who, text, detail, verdict, color, initials, created_at FROM event WHERE item_id = ? ORDER BY id DESC LIMIT 20',
)
const selectOutputs = db.prepare(
  "SELECT step_index, attempt, output, artifact, provider, model, verdict, verdict_summary, fallback_from, fallback_reset_at, source_shas FROM step_run WHERE item_id = ? AND status = 'done' ORDER BY id",
)
// Counts done+artifact rows only (a strict subset of the done rows above —
// some steps mark done without ever setting an artifact), so the board can
// show "attempt N of Y" without claiming a version exists that isn't
// actually reachable via listStepAttempts/the artifact route (HZ-46).
const selectAttemptCounts = db.prepare(
  "SELECT step_index, COUNT(*) AS n FROM step_run WHERE item_id = ? AND status = 'done' AND artifact IS NOT NULL GROUP BY step_index",
)

const selectJobView = db.prepare(
  `SELECT r.job_view FROM step_run r JOIN work_item w ON w.id = r.item_id
    WHERE r.item_id = ? AND r.step_index = ? AND w.cursor >= r.step_index ORDER BY r.id DESC LIMIT 1`,
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
      // HZ-357: the provider this attempt ran on, so the item page can show
      // "Ran on …". NULL for runs before the farm recorded it.
      provider: row.provider || null,
      // HZ-398: the model that attempt ran on. NULL before the farm recorded it.
      model: row.model || null,
      // HZ-429: Verify & report's verdict ('pass'|'fail') and its 1-3 line
      // summary. NULL on every other step and on runs before it was recorded.
      verdict: row.verdict ?? null,
      verdictSummary: row.verdict_summary ?? null,
      // HZ-422: "fell back from X: usage limit until <time>" when this attempt
      // ran on a fallback model, else null.
      fallbackNote: row.fallback_from ? fallbackNoteText(row.fallback_from, row.fallback_reset_at) : null,
    }
    // HZ-546: { 'owner/name': sha } the attempt read, so its code references
    // link at that commit. Absent when none was recorded (every earlier run).
    const sourceShas = parseSourceShas(row.source_shas)
    if (sourceShas) map[row.step_index].sourceShas = sourceShas
  }
  // HZ-407: the Execute card's job view, from the newest Execute run in any
  // status — live while it runs, the final view once it stopped or finished.
  // Not once the item went back before Execute (a send-back): that run's
  // view is history, not the job the card would act on.
  const jobRow = selectJobView.get(itemId, EXECUTE_STEP_INDEX)
  if (jobRow?.job_view) {
    try {
      const job = JSON.parse(jobRow.job_view)
      map[EXECUTE_STEP_INDEX] = { ...(map[EXECUTE_STEP_INDEX] ?? { label: STEPS[EXECUTE_STEP_INDEX]?.label ?? null }), job }
    } catch {
      // an unreadable view shows no panel
    }
  }
  return map
}

// HZ-546: step_run.source_shas as an object, or null when missing or unreadable.
export function parseSourceShas(json) {
  if (!json) return null
  try {
    const value = JSON.parse(json)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

// HZ-546: what the server's artifact and output pages need to build a link
// context (domain/js/codeRefs.js) for one item. knownIds is every stored item
// id; the UI builds its own set from the items it holds, so the two can differ.
export function linkInputs(itemId) {
  const item = db.prepare('SELECT repo, project_id, kind FROM work_item WHERE id = ?').get(itemId)
  return {
    projectRepos: item ? listRepos().filter((r) => r.project_id === item.project_id).map((r) => r.repo) : [],
    itemRepo: item?.repo ?? null,
    isPlan: !!item && itemKindOf(item) === 'plan',
    knownIds: new Set(db.prepare('SELECT id FROM work_item').all().map((r) => r.id)),
  }
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

// ---- the approved run plan (HZ-384) ----
// A Task's plan is its newest Run plan artifact. The hash covers the whole
// artifact, not just the block, so any re-run counts as a new plan.
const planHashOf = (artifact) => createHash('sha256').update(artifact, 'utf8').digest('hex')

// HZ-491: where a plan that sets no `runner` runs — the container only when
// the repo's deploy target pins an image (Admin → Deploy targets), else the
// host. Read on every call, so pinning or clearing an image moves it at once.
export function defaultRunnerFor(repo) {
  return repo && findTargetByRepo(repo)?.containerImage ? 'container' : 'host'
}

// The current plan, or null when the Run plan step has left no readable block.
// HZ-491: `runner` is the effective runner, worked out here once: the plan's
// own `runner` wins, else defaultRunnerFor(). Approve the run stores it, and
// Execute sends it to the farm, which applies no default of its own.
function currentRunPlan(itemId) {
  const artifact = latestArtifact(itemId, RUN_PLAN_STEP_INDEX)
  const block = extractRunPlan(artifact)
  if (!block) return null
  const repo = db.prepare('SELECT repo FROM work_item WHERE id = ?').get(itemId)?.repo ?? null
  const imagePinned = defaultRunnerFor(repo) === 'container'
  return { block, hash: planHashOf(artifact), runner: effectiveRunner(block, imagePinned), imagePinned }
}

// A kind whose lifecycle has the Approve the run gate approves a run plan
// there. HZ-446: keyed on that gate, not on any humanOnly gate — a Plan's
// Approve & file is human-only too, but it approves no run plan.
const approvesRunPlan = (kind) => stepsFor(kind).some((step) => step.index === APPROVE_RUN_GATE_INDEX)

// HZ-491: the warning an explicit container plan gets, before approval, when
// the repo has no image to run it in.
const NO_IMAGE_WARNING = 'no container image for this repo'

// What the Approve the run card shows, and the hash and runner its Approve
// sends back. HZ-491: `runner` is the effective runner, so a reload shows the
// same label the approver saw; `imagePinned` tells the card why a host run is
// on the host.
function runPlanView(itemId) {
  const plan = currentRunPlan(itemId)
  if (!plan) return null
  return {
    commands: plan.block.commands.length,
    budgetMinutes: plan.block.budget_minutes,
    hash: plan.hash,
    runner: plan.runner,
    imagePinned: plan.imagePinned,
    runnerWarning: plan.runner === 'container' && !plan.imagePinned ? NO_IMAGE_WARNING : null,
  }
}

// Whether the plan a human approved is still the plan on record. Execute's
// dispatch (orchestrator.js refuseUnapprovedRun) refuses to start otherwise.
// HZ-491: the approval also binds the effective runner — an image pinned or
// cleared since then changes it, and Execute refuses until re-approval. A
// row approved before the runner was stored has none, and must be re-approved.
export function approvedPlanCheck(itemId) {
  const row = db.prepare('SELECT approved_plan_hash, approved_runner FROM work_item WHERE id = ?').get(itemId)
  const approvedHash = row?.approved_plan_hash
  if (!approvedHash) return { error: 'plan_not_approved' }
  const plan = currentRunPlan(itemId)
  const currentHash = plan?.hash ?? null
  if (currentHash !== approvedHash || plan.runner !== row.approved_runner) {
    return {
      error: REASON.PLAN_CHANGED_SINCE_APPROVAL,
      approvedHash,
      currentHash,
      approvedRunner: row.approved_runner ?? null,
      runner: plan?.runner ?? null,
    }
  }
  return { ok: true, hash: approvedHash, runner: plan.runner }
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

// The attempt the next dispatch of a step records, moved out of the
// orchestrator's kick() unchanged (HZ-389) so /reject can name it in its
// answer and the two never disagree. HZ-321: a run a self-deploy stopped was
// never a finished attempt, so its redispatch keeps that run's attempt and
// auto-retry count. HZ-346: nor is a run a rule blocked — the block does not
// use up an attempt. A pure read: nothing is written.
const selectLastStepRun = db.prepare(
  'SELECT attempt, auto_retry_count, deploy_interrupted, rule_blocked, usage_limit_hit FROM step_run WHERE item_id = ? AND step_index = ? ORDER BY id DESC LIMIT 1',
)
const selectNextAttempt = db.prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM step_run WHERE item_id = ? AND step_index = ?')

export function nextStepAttempt(id, stepIndex) {
  const last = selectLastStepRun.get(id, stepIndex)
  // HZ-422: nor is a run a usage limit stopped — it re-runs on the next model.
  const keepsAttempt = last?.deploy_interrupted === 1 || last?.rule_blocked === 1 || last?.usage_limit_hit === 1
  return {
    attempt: keepsAttempt ? last.attempt : selectNextAttempt.get(id, stepIndex).n,
    keepsAttempt,
    autoRetryCount: keepsAttempt ? last.auto_retry_count : null,
  }
}

// ---- usage limits (HZ-422) ----
// The ledger of models seen usage-limited (model_limit) and the item-level
// wait for when every model a step may run on is limited. Times are ISO-8601
// UTC strings, compared in JS with Date.parse so a test's fake clock drives them.

const upsertModelLimit = db.prepare(
  `INSERT INTO model_limit (model, provider, reset_at, note, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
   ON CONFLICT(model) DO UPDATE SET provider = excluded.provider, reset_at = excluded.reset_at, note = excluded.note, updated_at = excluded.updated_at`,
)
const selectModelLimits = db.prepare('SELECT model, reset_at FROM model_limit')

export function markModelLimited(provider, model, resetAtIso, note = null) {
  upsertModelLimit.run(model, provider, resetAtIso, note)
}

// model id -> reset in epoch ms, for every limit still active at nowMs.
export function activeModelLimits(nowMs) {
  const limits = new Map()
  for (const row of selectModelLimits.all()) {
    const at = Date.parse(row.reset_at)
    if (at > nowMs) limits.set(row.model, at)
  }
  return limits
}

export function setUsageWait(id, untilIso) {
  db.prepare(`UPDATE work_item SET usage_wait_until = ?, ${touch} WHERE id = ?`).run(untilIso, id)
}

export function listUsageWaits() {
  return db.prepare('SELECT id, usage_wait_until FROM work_item WHERE usage_wait_until IS NOT NULL').all()
}

// Folds the farm's cached {state, reason} onto an active run (HZ-54). No
// entry for this run — mock mode, an old/unreachable farm, or a poll that
// simply hasn't landed yet — defaults to 'running', i.e. today's behavior.
function withRunState(activeRun) {
  if (!activeRun) return null
  const cached = runStateProvider()[String(activeRun.id)]
  return { ...activeRun, state: cached?.state || 'running', reason: cached?.reason || null }
}

// ---- Farm health (HZ-563), read-only ----
const selectActiveRunsForHealth = db.prepare(
  "SELECT id, item_id, step_index, started_at FROM step_run WHERE status = 'active' ORDER BY started_at, id",
)
const selectLiveDeploysSince = db.prepare(
  'SELECT target, tag, live_at FROM deploy_batch WHERE live_at IS NOT NULL AND live_at >= ? ORDER BY live_at DESC LIMIT 20',
)

// Every active run with the farm's cached queued/running state folded on.
export function listActiveRunsWithState() {
  return selectActiveRunsForHealth.all().map(withRunState)
}

// Deploys that went live at or after `sinceSql` (SQLite datetime form), newest first.
export function listLiveDeploysSince(sinceSql) {
  return selectLiveDeploysSince.all(sinceSql)
}

// ---- dependencies (HZ-78) ----
// item_id is held by the depends_on_id rows it names (see domain/js/lifecycle.js
// holdingBlockers). HZ-467: a change item plans freely and waits only from
// implement on, until each blocker has merged (merged_at) or closed; other
// kinds wait on every step until each blocker closes. Enforced at dispatch
// time in orchestrator.js's runnable() — the same gate that already decides
// dispatch — via blockersOf below; the API-facing `blocked` field here is
// read-only reporting of that same derived state, not a second source of truth.

const selectBlockers = db.prepare(
  `SELECT w.* FROM work_item_dependency d JOIN work_item w ON w.id = d.depends_on_id WHERE d.item_id = ? ORDER BY d.depends_on_id`,
)
const selectDependents = db.prepare(
  `SELECT w.* FROM work_item_dependency d JOIN work_item w ON w.id = d.item_id WHERE d.depends_on_id = ? ORDER BY d.item_id`,
)
const selectDependentIds = db.prepare('SELECT item_id FROM work_item_dependency WHERE depends_on_id = ?')
const selectDependsOnIds = db.prepare('SELECT depends_on_id FROM work_item_dependency WHERE item_id = ?')
const selectCursorKind = db.prepare('SELECT cursor, kind FROM work_item WHERE id = ?')

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

// HZ-469: the open items (not closed, not abandoned) that depend on any of
// `itemIds`, as {id, dependsOn}. The deploy queue closes a batch's window
// early when one is waiting on a member.
export function openDependentsOfAny(itemIds) {
  const found = []
  for (const dependsOn of itemIds) {
    for (const row of selectDependents.all(dependsOn)) {
      if (!isClosed(row) && !isAbandoned(row)) found.push({ id: row.id, dependsOn })
    }
  }
  return found
}

// HZ-604: which of `ids` are finished, as {id, state: 'closed'|'abandoned'}.
// farmd's hourly clean-up reaps only these items' worktrees. Its dirs are
// lowercased (workspace_path), so the match ignores case. Open and unknown ids
// are left out, so a worktree the server can't vouch for is never reaped.
// Abandoned wins over closed.
export function finishedItems(ids) {
  if (ids.length === 0) return []
  const wanted = [...new Set(ids.map((id) => id.toLowerCase()))]
  const rows = db
    .prepare(
      `SELECT id, cursor, kind, abandoned_at FROM work_item WHERE lower(id) IN (${wanted.map(() => '?').join(', ')}) ORDER BY id`,
    )
    .all(...wanted)
  const found = []
  for (const row of rows) {
    if (isAbandoned(row)) found.push({ id: row.id, state: 'abandoned' })
    else if (isClosed(row)) found.push({ id: row.id, state: 'closed' })
  }
  return found
}

// HZ-591: open items in `repo` that may merge soon — at Accept the code, or
// with a running premerge gate action — other than `excludeIds` (a deploy
// batch's own members). The deploy queue keeps a batch's window open only
// while one exists. `cursor` is a global STEPS index, so only change items can
// sit at ACCEPT_GATE_INDEX. A premerge normally runs while the item is still
// at Accept, so that clause is belt-and-braces. Paused items still count;
// closed and abandoned ones don't. An item that merged but hasn't joined yet
// is past Accept and doesn't count; join() runs right after the merge.
const selectComingToDeploy = db.prepare(`
  SELECT w.id, w.cursor, w.kind, w.abandoned_at FROM work_item w
   WHERE w.repo = ? AND (w.cursor = ? OR EXISTS (
     SELECT 1 FROM gate_action g WHERE g.item_id = w.id AND g.kind = 'premerge' AND g.state = 'running'))
   ORDER BY w.id`)

export function itemsComingToDeploy(repo, excludeIds = []) {
  const excluded = new Set(excludeIds)
  return selectComingToDeploy
    .all(repo, ACCEPT_GATE_INDEX)
    .filter((row) => !excluded.has(row.id) && !isClosed(row) && !isAbandoned(row))
    .map((row) => ({ id: row.id }))
}

// HZ-313: the same check addDependency runs, for split.js to refuse a plan
// whose already-filed upstream item now depends on this one.
export function wouldCycleBetween(id, dependsOnId) {
  return wouldCycle(id, dependsOnId)
}

// `blocked` says whether the item is held at its current step. `blockedBy`
// lists every edge to a blocker that has not closed, held or not, so each one
// can still be seen and removed; `merged` marks a blocker whose PR is on main.
// `row` (cursor, kind) saves a read when the caller already has it.
function dependencyFields(id, row = selectCursorKind.get(id)) {
  const blockers = blockersOf(id)
  const dependents = selectDependents.all(id)
  return {
    blocked: row ? holdingBlockers(row, blockers).length > 0 : false,
    blockedByAbandoned: isBlockedByAbandoned(blockers),
    blockedBy: blockers
      .filter((b) => !isClosed(b))
      .map((b) => ({ id: b.id, title: b.title, abandoned: isAbandoned(b), merged: !!b.merged_at })),
    dependents: dependents
      .filter((d) => !isClosed(d))
      .map((d) => ({ id: d.id, title: d.title, abandoned: isAbandoned(d) })),
  }
}

// HZ-379: who filed this item and what this item filed (server/src/spawn.js
// writes item_spawn). Every filed child is listed, open or closed, so the
// parent's page keeps the whole record; read here, not in spawn.js, because
// spawn.js imports this module.
const selectSpawnedBy = db.prepare(`
  SELECT w.id, w.title FROM item_spawn s JOIN work_item w ON w.id = s.parent_id
   WHERE s.child_id = ? AND s.status = 'filed' ORDER BY s.id LIMIT 1`)
const selectSpawned = db.prepare(`
  SELECT w.* FROM item_spawn s JOIN work_item w ON w.id = s.child_id
   WHERE s.parent_id = ? AND s.status = 'filed' ORDER BY s.id`)

export function spawnFields(id) {
  const parent = selectSpawnedBy.get(id)
  return {
    spawnedBy: parent ? { id: parent.id, title: parent.title } : null,
    spawned: selectSpawned
      .all(id)
      .map((c) => ({ id: c.id, title: c.title, closed: isClosed(c), abandoned: isAbandoned(c) })),
  }
}

// HZ-547: every item that filed at least one item (a Plan or a Task), open or
// closed, keyed by id — for planProgress.js. Read-only, like spawnFields.
const selectSpawnParents = db.prepare(`
  SELECT DISTINCT w.* FROM item_spawn s JOIN work_item w ON w.id = s.parent_id
   WHERE s.status = 'filed'`)

export function spawnParents() {
  return new Map(
    selectSpawnParents
      .all()
      .map((row) => [row.id, { id: row.id, kind: itemKindOf(row), title: row.title, closed: isClosed(row) }]),
  )
}

// Wakes every item that names `id` as a blocker — called once `id` has
// merged (markMerged) or actually closed, from every place isClosed can flip
// false -> true (approveGate, approveGateFromGithub, and upsertFromGithub's
// GitHub-close sync). kick() itself re-checks runnable() (which re-checks
// blockersOf), so a dependent with a second still-open blocker safely no-ops
// here, and a second wake for the same blocker is harmless.
function wakeDependents(id) {
  for (const row of selectDependentIds.all(id)) {
    releaseRuleBlockIfSatisfied(row.item_id)
    agentRunner.kick(row.item_id)
  }
}

// HZ-580: the ids of the dependencies this item gained at or after `since` (a
// rule block's blockedAt). Both columns are SQLite text in the same
// `YYYY-MM-DD HH:MM:SS` form, so the comparison stays here, in one place:
// releaseRuleBlockIfSatisfied and the banner's waitingOn cannot disagree.
const selectDependencyIdsSince = db.prepare(
  'SELECT depends_on_id FROM work_item_dependency WHERE item_id = ? AND created_at >= ?',
)

function dependencyIdsAddedSince(id, since) {
  return new Set(selectDependencyIdsSince.all(id, since).map((r) => r.depends_on_id))
}

// HZ-580: the block plus `waitingOn` — its open, unmerged blockers that were
// added after the block, which the banner leads with. [] when the block has no
// blockedAt (rows from before HZ-346 recorded it).
function ruleBlockView(id, block, blockedBy) {
  const since = block.blockedAt ? dependencyIdsAddedSince(id, block.blockedAt) : new Set()
  return {
    ...block,
    waitingOn: blockedBy.filter((b) => since.has(b.id) && !b.merged).map((b) => ({ id: b.id, title: b.title })),
  }
}

// HZ-346: a rule-blocked item restarts once a dependency it gained after the
// block, and every other blocker, has merged or closed (HZ-467: a rule block
// only ever stops implement, so it lifts at merge too). A dependency that predates the
// block is not why it is waiting, so it never releases it; nor does removing
// one. Returns whether the block was cleared — the caller kicks.
export function releaseRuleBlockIfSatisfied(id) {
  const row = db.prepare('SELECT rule_block_json FROM work_item WHERE id = ?').get(id)
  const block = parseRuleBlock(row?.rule_block_json)
  if (!block?.blockedAt) return false
  const blockers = blockersOf(id)
  if (blockers.length === 0 || isImplementBlocked(blockers)) return false
  if (dependencyIdsAddedSince(id, block.blockedAt).size === 0) return false
  db.prepare(`UPDATE work_item SET rule_block_json = NULL, ${touch} WHERE id = ?`).run(id)
  addEvent(id, {
    who: 'Horizon',
    text: 'its dependencies are merged or closed — the rule block is cleared and implement restarts',
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

// Declares that `id` waits on `dependsOnId` (see holdingBlockers). Validated,
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
//
// HZ-466: when someone other than Horizon removes an edge Horizon created, the
// pair is recorded in overlap_link_removal so step 9 does not re-add it. That
// also covers Horizon edges from spawn.js and split.js, not only overlap ones:
// the record only ever stops an overlap link for that exact pair, so it is
// harmless. split.js's own cleanups pass actor 'Horizon' and record nothing.
export function removeDependency(id, dependsOnId, actor = 'You') {
  const it = getItem(id)
  if (!it) return { error: 'not_found' }
  if (disabledProject(it)) return { error: 'project_not_active' }
  const removed = db.transaction(() => {
    const edge = db.prepare('SELECT created_by FROM work_item_dependency WHERE item_id = ? AND depends_on_id = ?').get(id, dependsOnId)
    if (!edge) return false
    db.prepare('DELETE FROM work_item_dependency WHERE item_id = ? AND depends_on_id = ?').run(id, dependsOnId)
    if (edge.created_by === 'Horizon' && actor !== 'Horizon') {
      const [a, b] = [id, dependsOnId].sort()
      db.prepare('INSERT OR IGNORE INTO overlap_link_removal (item_a, item_b, removed_by) VALUES (?, ?, ?)').run(a, b, actor)
    }
    return true
  })()
  if (!removed) return { error: 'not_found' }
  addEvent(id, { who: actor, text: `removed the dependency on ${dependsOnId}`, color: '#5E4380', initials: 'YOU' })
  notify()
  agentRunner.kick(id)
  return { ok: true, ...dependencyFields(id) }
}

// HZ-466: the owner removal recorded for this item pair, in either order, or
// null. overlapService.applyOverlap reads it before adding an overlap link.
export function overlapLinkRemoval(a, b) {
  const [itemA, itemB] = [a, b].sort()
  return db.prepare('SELECT removed_by, removed_at FROM overlap_link_removal WHERE item_a = ? AND item_b = ?').get(itemA, itemB) || null
}

// Where an item stands, resolved server-side so non-UI clients (the WhatsApp
// concierge) don't need their own copy of the STEPS table. The phase name
// comes from the item's own kind, since each kind numbers its own phases.
function currentStepOf(row) {
  if (isClosed(row)) return { index: row.cursor, label: 'Closed', kind: 'done', phase: 'Done', gate: false }
  const step = STEPS[row.cursor]
  const kind = itemKindOf(row)
  return { index: row.cursor, label: step.label, kind: step.kind, phase: phasesFor(kind)[step.phase], gate: step.kind === 'gate' }
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

// HZ-389: one item as the v2 stream upserts it (no stepOutputs), or null — so
// an action's answer carries the state it just wrote.
const selectItemRow = db.prepare(
  `SELECT w.*, (SELECT MAX(s.ended_at) FROM step_run s WHERE s.item_id = w.id) AS last_run_ended_at
   FROM work_item w WHERE w.id = ?`,
)

export function itemViewById(id) {
  const row = selectItemRow.get(id)
  return row ? itemView(row, { stepOutputs: false }) : null
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
// HZ-481: also the entry a batch released while it is `verifying` (live, smoke
// check running), and the facts each stage of the card's line needs. Every
// HZ-333 key keeps its name and meaning; the new ones are added beside them.
const selectQueuedEntry = db.prepare(`
  SELECT e.target, e.status, b.status AS batch_status, b.window_closes_at, b.tag,
         b.id AS batch_id, b.started_at, b.live_at
    FROM deploy_queue_entry e JOIN deploy_batch b ON b.id = e.batch_id
   WHERE e.item_id = ?
     AND (e.status = 'queued' OR (e.status = 'released' AND b.status = 'verifying' AND b.live_at IS NOT NULL))`)

// HZ-481: how long the target's last 5 deploys took, publish start to live,
// in seconds — the history "live about" is estimated from.
const selectRecentDeploySeconds = db.prepare(`
  SELECT (julianday(live_at) - julianday(started_at)) * 86400 AS s FROM deploy_batch
   WHERE target = ? AND live_at IS NOT NULL AND started_at IS NOT NULL
   ORDER BY id DESC LIMIT 5`)

// HZ-481: when a deploy of `target` should be live, as ISO UTC, or null with
// no usable history: the drain's end (else now) plus the median of the last
// 5 durations. The median counts publish, deploy-hold (HZ-408) and drain
// time too, so a run of long waits moves the estimate later.
export function liveEtaFor(target, { drainEndMs = null, nowMs = Date.now() } = {}) {
  const durations = selectRecentDeploySeconds
    .all(target)
    .map((row) => row.s)
    .filter((s) => Number.isFinite(s) && s >= 0)
    .sort((a, b) => a - b)
  if (durations.length === 0) return null
  const mid = Math.floor(durations.length / 2)
  const median = durations.length % 2 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2
  const base = Number.isFinite(drainEndMs) ? drainEndMs : nowMs
  return new Date(base + Math.round(median * 1000)).toISOString()
}

// HZ-481: short step names for the drain line; any other step reads as its
// stepSlug(). Keyed by step index, so a relabel cannot unhook them.
const DRAIN_STEP_NAMES = new Map([
  [IMPLEMENT_STEP_INDEX, 'implement'],
  [REVIEW_STEP_INDEX, 'review'],
])

// HZ-481: what a Horizon self-deploy's drain is waiting on — the agent steps
// a restart would break (HZ-469: deployDrain's survivesRestart) and the
// running premerge/resolve gate actions — as [{item_id, step}].
function drainWaiting() {
  const steps = listRunningAgentSteps()
    .filter((run) => !deployDrainProvider.survives(run.stepIndex))
    .map((run) => ({ item_id: run.itemId, step: DRAIN_STEP_NAMES.get(run.stepIndex) ?? run.step }))
  const gateActions = listRunningGateActions().map((run) => ({ item_id: run.itemId, step: run.kind }))
  return [...steps, ...gateActions].sort((a, b) => a.item_id.localeCompare(b.item_id, 'en', { numeric: true }))
}

export function deployQueueStateFor(itemId, now = Date.now()) {
  const row = selectQueuedEntry.get(itemId)
  if (!row) return null
  const state = {
    ...row,
    window_closes_at: toIsoUtc(row.window_closes_at),
    started_at: toIsoUtc(row.started_at),
    live_at: toIsoUtc(row.live_at),
  }
  if (row.batch_status !== 'deploying') return state
  // The drain block is process-wide; only a Horizon self-deploy drains.
  let drainEndMs = null
  const block = row.target === 'horizon' ? deployDrainProvider.block(now) : null
  if (block) {
    state.drain_started_at = block.startedAt
    state.drain_deadline = block.latestEnd
    state.drain_waiting = drainWaiting()
    drainEndMs = Date.parse(block.latestEnd)
  }
  // The drain's end is never stored (a restart ends it), so this is when
  // the batch started publishing.
  state.deploying_since = state.started_at
  const eta = liveEtaFor(row.target, { drainEndMs, nowMs: now })
  if (eta) state.live_eta = eta
  return state
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
  return gateReachedAt(row)
}

// When the item reached the gate its cursor is on — rule 4 above. Shared by
// stateSince and waitingSince so the two never disagree on it.
function gateReachedAt(row) {
  return toIsoUtc(row.last_run_ended_at ?? row.created_at)
}

// HZ-443: the SET clause every pause path writes. A repeat pause keeps the
// first paused_at, so the wait counts from when the pause began.
export const PAUSE_SET = "paused = 1, paused_at = CASE WHEN paused = 1 AND paused_at IS NOT NULL THEN paused_at ELSE datetime('now') END"

// HZ-443: when the item started waiting on a human — the board's "Waiting on
// me" filter and sort — ISO UTC, or null when it is not waiting. In order:
//   1. closed, abandoned or rejected → null;
//   2. paused → when the pause began (paused_at, set by PAUSE_SET);
//   3. rule-blocked → the block's blockedAt;
//   4. at a gate → when it reached the gate. Unlike stateSince, a running gate
//      action does not restart the wait;
//   5. anything else (an agent working) → null.
// A new pause path must write PAUSE_SET, or its items show no wait.
function waitingSince(row, ruleBlock) {
  if (isClosed(row) || row.abandoned_at || row.rejected) return null
  if (row.paused) return toIsoUtc(row.paused_at)
  if (ruleBlock) return toIsoUtc(ruleBlock.blockedAt)
  if (STEPS[row.cursor]?.kind === 'gate') return gateReachedAt(row)
  return null
}

const selectProjectProviderDefaults = db.prepare('SELECT provider_defaults_json FROM project WHERE id = ?')
const selectProjectAutopilot = db.prepare('SELECT autopilot FROM project WHERE id = ?')
// HZ-544: the newest evaluation Autopilot recorded at this gate while it was
// off for the item — what it would have done. Gate-scoped, so a decision from
// an earlier gate never shows at this one.
const selectItemOffEval = db.prepare(
  'SELECT decision, reason FROM caretaker_eval WHERE item_id = ? AND gate_index = ? AND item_off = 1 ORDER BY id DESC LIMIT 1',
)

function autopilotWouldHave(row) {
  if (!row.autopilot_off) return null
  const evaluation = selectItemOffEval.get(row.id, row.cursor)
  return evaluation ? { decision: evaluation.decision, reason: evaluation.reason } : null
}

// HZ-422: null once the wait has passed, even before kick() clears the column.
function usageWaitView(row) {
  const until = row.usage_wait_until
  if (!until || !(Date.parse(until) > Date.now())) return null
  return { until, text: usageWaitText(until) }
}

function itemView(row, { stepOutputs: withStepOutputs = true } = {}) {
  const activeRun = withRunState(selectActiveRun.get(row.id) || null)
  const overlay = projectOverlayFor(row.project_id)
  const personas = personasFromRow(row, overlay)
  const gateFields = itemGateFields(row)
  const ruleBlock = parseRuleBlock(row.rule_block_json)
  const dependencies = dependencyFields(row.id, row)
  return {
    id: row.id,
    title: row.title,
    priority: row.priority,
    kind: itemKindOf(row),
    // HZ-435: the lane overlay, or null for the full pipeline.
    lane: laneOf(row),
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
    personas,
    personaBadges: personaBadges(personas, overlay),
    providerChoices: providerChoicesFromRow(row),
    // HZ-370: for the item page's "Default" label only; the farm is sent the
    // merged map (resolveStepProviders) at dispatch instead.
    projectProviderDefaults: providerDefaultsFromRow(row.project_id == null ? null : selectProjectProviderDefaults.get(row.project_id)),
    // HZ-544: the `autopilot-off` label as last synced, and the project's
    // Autopilot mode, so a page can tell "off for this item" applies (only
    // in an 'on' project — see caretaker.js's itemOff).
    autopilotOff: !!row.autopilot_off,
    projectAutopilot: (row.project_id == null ? null : selectProjectAutopilot.get(row.project_id)?.autopilot) ?? 'off',
    autopilotWouldHave: autopilotWouldHave(row),
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
    ...dependencies,
    ...spawnFields(row.id),
    ruleBlock: ruleBlock && ruleBlockView(row.id, ruleBlock, dependencies.blockedBy),
    // HZ-422: every model this step may run on is usage-limited until `until`.
    usageWait: usageWaitView(row),
    // HZ-443: the board's "Waiting on me" filter and sort.
    paused_at: row.paused ? toIsoUtc(row.paused_at) : null,
    waiting_since: waitingSince(row, ruleBlock),
    // HZ-384: the plan the Approve the run gate shows, and the one approved.
    ...(approvesRunPlan(itemKindOf(row)) ? { runPlan: runPlanView(row.id), approvedPlanHash: row.approved_plan_hash ?? null } : {}),
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
  // `kind` normalizes the same way (HZ-377): missing reads as `change`.
  return {
    ...row,
    kind: itemKindOf(row),
    lane: laneOf(row),
    paused: !!row.paused,
    rejected: !!row.rejected,
    personas: personasFromRow(row, projectOverlayFor(row.project_id)),
    providerChoices: providerChoicesFromRow(row),
  }
}

// ---- per-step provider choice (HZ-357) ----
// What an owner may pick for a step comes from domain/providers.json (HZ-398):
// a bare provider name (the pre-HZ-398 form, still accepted and never
// rewritten) or "<provider>:<model id>" for one of its selectable models — see
// choiceValues(). "default" is not stored: it deletes the step's key, so an
// item with no choices keeps an empty map and runs exactly as before.

// Only a step domain/steps.json marks providerOverrideEligible takes a choice;
// the farm applies the same rule, and deploy stays provider-locked.
function providerOverrideEligible(stepIndex) {
  return STEPS[stepIndex]?.kind === 'agent' && STEPS[stepIndex].providerOverrideEligible === true
}

// The item's { "<step index>": provider } map. Anything a reader must not act
// on — junk JSON, an unknown provider, a step that isn't eligible — is dropped.
export function providerChoicesFromRow(row) {
  return providerMapFromJson(row?.provider_choices_json)
}

// HZ-370: the project's per-step default, the same shape and filter as an
// item's choices — so a stored default for deploy is never acted on.
export function providerDefaultsFromRow(row) {
  return providerMapFromJson(row?.provider_defaults_json)
}

// HZ-370: the providers the farm is sent for an item — per step, the item's
// choice, else the project's default. A step with neither gets no key, which
// is today's routing. Pure: the orchestrator calls it at dispatch.
export function resolveStepProviders(itemChoices, projectDefaults) {
  return { ...(projectDefaults ?? {}), ...(itemChoices ?? {}) }
}

function eligibleEntriesFromJson(json) {
  if (typeof json !== 'string' || !json.trim()) return []
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  return Object.entries(parsed).filter(([step]) => /^\d+$/.test(step) && providerOverrideEligible(Number(step)))
}

function providerMapFromJson(json) {
  const choices = {}
  for (const [step, value] of eligibleEntriesFromJson(json)) {
    if (parseChoice(value)) choices[step] = value
  }
  return choices
}

// HZ-398: the stored choices of an item's or project's JSON that name a known
// provider but a model domain/providers.json no longer offers, as
// [{ step, value }]. providerMapFromJson already drops them, so they run on
// Default; the orchestrator says so on the item at dispatch. The stored row is
// left as it is.
export function staleStepChoices(json) {
  const names = providerNames()
  return eligibleEntriesFromJson(json)
    .filter(([, value]) => typeof value === 'string' && !parseChoice(value) && names.includes(value.split(':')[0]))
    .map(([step, value]) => ({ step: Number(step), value }))
}

// The owner's "Runs on" choice for one step. The farm reads it from the task
// at the next dispatch of that step, so a run already in progress keeps the
// provider it started on. Refuses, writing nothing, a step that isn't
// eligible (provider_not_eligible — the route maps it to 400).
export function setStepProvider(id, stepIndex, provider, actor = 'You') {
  const it = getItem(id)
  if (!it) return { error: 'not_found' }
  if (disabledProject(it)) return { error: 'project_not_active' }
  if (isClosed(it)) return { error: 'closed' }
  if (isAbandoned(it)) return { error: 'abandoned' }
  if (!providerOverrideEligible(stepIndex)) return { error: 'provider_not_eligible' }
  if (provider !== 'default' && !choiceValues().includes(provider)) return { error: 'bad_provider' }

  const choices = { ...it.providerChoices }
  if (provider === 'default') delete choices[stepIndex]
  else choices[stepIndex] = provider
  const json = Object.keys(choices).length > 0 ? JSON.stringify(choices) : null
  db.prepare(`UPDATE work_item SET provider_choices_json = ?, ${touch} WHERE id = ?`).run(json, id)
  addEvent(id, {
    who: actor,
    text: `set ${STEPS[stepIndex].label} to run on ${provider === 'default' ? 'the default provider' : choiceLabel(provider)}`,
    color: '#5E4380',
    initials: 'YOU',
  })
  notify()
  return { ok: true }
}

// HZ-370: the project's default for one step, set in Admin. The ONLY writer
// of project.provider_defaults_json; its one caller is the PIN-gated route in
// app.js. Refuses, writing nothing, a step that isn't eligible — deploy
// included — so the rule holds on the server, not only in the UI. The value
// and its audit row land in one transaction; a same-value write records
// nothing. "default" deletes the key, and an empty map is stored as NULL.
export function setProjectStepProvider(projectId, stepIndex, provider, who) {
  if (!providerOverrideEligible(stepIndex)) return { error: 'provider_not_eligible' }
  if (provider !== 'default' && !choiceValues().includes(provider)) return { error: 'bad_provider' }
  const result = db.transaction(() => {
    const row = db.prepare('SELECT provider_defaults_json FROM project WHERE id = ?').get(projectId)
    if (!row) return { error: 'not_found' }
    const defaults = providerDefaultsFromRow(row)
    const old = defaults[stepIndex] ?? 'default'
    if (old === provider) return { ok: true, old, new: provider, unchanged: true }
    if (provider === 'default') delete defaults[stepIndex]
    else defaults[stepIndex] = provider
    const json = Object.keys(defaults).length > 0 ? JSON.stringify(defaults) : null
    db.prepare('UPDATE project SET provider_defaults_json = ? WHERE id = ?').run(json, projectId)
    db.prepare(
      "INSERT INTO project_event (project_id, kind, old_value, new_value, who) VALUES (?, 'step_provider', ?, ?, ?)",
    ).run(projectId, `${stepIndex}:${old}`, `${stepIndex}:${provider}`, who)
    return { ok: true, old, new: provider }
  })()
  if (result.ok && !result.unchanged) notify()
  return result
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

// detail (HZ-373): the full failure message behind a check headline in
// `text`, for "Show details"; null for every other event.
export function addEvent(id, { who, text, color, initials, detail = null, verdict = null }) {
  db.prepare('INSERT INTO event (item_id, who, text, color, initials, detail, verdict) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    who,
    text,
    color,
    initials,
    detail,
    verdict,
  )
}

// HZ-384: a humanOnly gate (domain/steps.json) passes only with `proof` —
// the object app.js's humanAuthorized() mints after a session and a valid gate
// PIN. Every approver reaches this one function, so a caller without it
// (WhatsApp, the caretaker, a token, any route added later) is refused here,
// the gate stays pending and the refusal is logged. `planHash` is the plan
// the approver was shown: a newer plan since then is refused, not approved.
// HZ-446: the PIN applies to every humanOnly gate; the run plan checks only to
// Approve the run, the one gate that approves a run plan.
export function approveGate(id, stepIndex, notes, actor = 'You', { proof = null, planHash = null, runner = null } = {}) {
  const it = getItem(id)
  if (!it) return { error: 'not_found' }
  if (disabledProject(it)) return { error: 'project_not_active' }
  if (isClosed(it) || isAbandoned(it) || STEPS[it.cursor].kind !== 'gate') return { error: 'not_at_gate' }
  if (stepIndex !== it.cursor) return { error: 'stale_step' }

  let approvedHash = null
  let approvedRunner = null
  if (isHumanOnlyGate(stepIndex)) {
    if (!isHumanProof(proof)) {
      addEvent(id, {
        who: actor,
        text: `could not approve “${STEPS[stepIndex].label}”: it needs a human with the gate PIN — the gate stays open`,
        color: '#9C333E',
        initials: '✕',
      })
      notify()
      return { error: 'human_pin_required' }
    }
  }
  if (stepIndex === APPROVE_RUN_GATE_INDEX) {
    const plan = currentRunPlan(id)
    if (!plan) return { error: 'run_plan_missing' }
    if (planHash != null && planHash !== plan.hash) return { error: 'run_plan_changed' }
    // HZ-491: the runner the card showed, so an image pinned or cleared
    // since the load is not approved unseen.
    if (runner != null && runner !== plan.runner) return { error: 'run_plan_changed' }
    approvedHash = plan.hash
    approvedRunner = plan.runner
  }

  const trimmed = (notes || '').trim()
  const next = nextCursor(it)
  db.prepare(
    `UPDATE work_item SET cursor = ?, rejected = 0${approvedHash ? ', approved_plan_hash = ?, approved_runner = ?' : ''}, ${touch} WHERE id = ?`,
  ).run(...(approvedHash ? [next, approvedHash, approvedRunner, id] : [next, id]))
  db.prepare(
    'INSERT INTO gate_decision (item_id, step_index, decision, notes, decided_by, plan_hash) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, stepIndex, 'approved', trimmed, actor, approvedHash)
  if (trimmed) {
    // Approval notes are direction for whoever runs next — queue as feedback
    // so the next dispatched agent step receives and must address them.
    db.prepare('INSERT INTO feedback (item_id, target, message) VALUES (?, ?, ?)').run(
      id,
      STEPS[next]?.agent || '',
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

  // A send-back never crosses into another kind's rows: the walk and any
  // explicit target both stop at this item's own first step (HZ-377).
  const first = firstStepIndex(itemKindOf(it))
  if (targetStepIndex != null) {
    const atGate = STEPS[it.cursor]?.kind === 'gate'
    const validTarget =
      Number.isInteger(targetStepIndex) &&
      targetStepIndex >= first &&
      targetStepIndex < it.cursor &&
      STEPS[targetStepIndex]?.kind === 'agent' &&
      !isServerStep(targetStepIndex) &&
      !laneSkips(it).has(targetStepIndex)
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
    } else if (it.cursor === APPROVE_RUN_GATE_INDEX) {
      // HZ-384: Impact review sits right before this gate, but rejecting the
      // run means the PLAN is wrong — send it back to Run plan to redo it.
      reworkIdx = RUN_PLAN_STEP_INDEX
    } else {
      // HZ-435: never onto a row the item's lane skips. HZ-446: nor onto a
      // server step — it has no agent to take the feedback, and HZ-449's File
      // items files real issues, so a send-back must never re-run it.
      const skips = laneSkips(it)
      while (reworkIdx > first && (STEPS[reworkIdx].kind !== 'agent' || isServerStep(reworkIdx) || skips.has(reworkIdx))) {
        reworkIdx--
      }
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
  const resetReview = it.kind === 'change' && reworkIdx <= IMPLEMENT_STEP_INDEX ? RESET_REVIEW_STATE : ''
  // HZ-346: a human send-back is never held by a rule block. HZ-384: and it
  // retires any approved run plan — the run must be approved again, against
  // whatever plan it comes back with (always NULL on a change item).
  db.prepare(
    `UPDATE work_item SET cursor = ?, rejected = 0, paused = 0, rule_block_json = NULL, approved_plan_hash = NULL, approved_runner = NULL${resetReview}, ${touch} WHERE id = ?`,
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
  const pausedSet = paused ? PAUSE_SET : 'paused = 0'
  db.prepare(`UPDATE work_item SET ${pausedSet}, ${unblock}${touch} WHERE id = ?`).run(id)
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
  // HZ-385: the state just written, so the page can show it without waiting
  // for the stream.
  return { ok: true, paused: Boolean(paused) }
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
  const overlay = projectOverlayFor(it.project_id)
  if (!isPersona(agent, persona, overlay)) return { error: 'bad_persona' }

  const merged = { ...it.personas, [agent]: persona }
  db.prepare(`UPDATE work_item SET personas_json = ?, ${touch} WHERE id = ?`).run(JSON.stringify(merged), id)
  addEvent(id, {
    who: 'You',
    text: `set the ${agent} specialist persona to ${personaLabel(agent, persona, overlay)}`,
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
  // The phase restarts within the item's own kind: phase numbers repeat
  // across kinds, so an unscoped lookup would land a task on change rows.
  const kind = itemKindOf(it)
  // HZ-435: the phase's first row the item's lane does not skip.
  const skips = laneSkips(it)
  const found = stepsFor(kind).find((st) => st.phase === phase && !skips.has(st.index))
  if (!found) return { error: 'bad_phase' }
  const firstIdx = found.index

  agentRunner.cancel(id, 'superseded')
  if (reason) {
    // The restart reason is feedback: the first re-run agent must address it.
    db.prepare('INSERT INTO feedback (item_id, target, message) VALUES (?, ?, ?)').run(
      id,
      STEPS[firstIdx].agent || '',
      reason,
    )
  }
  const resetReview = kind === 'change' && firstIdx <= IMPLEMENT_STEP_INDEX ? RESET_REVIEW_STATE : ''
  // HZ-346: a restart moves the cursor, so a rule block must not hold it.
  db.prepare(
    `UPDATE work_item SET cursor = ?, rejected = 0, paused = 0, rule_block_json = NULL${resetReview}, ${touch} WHERE id = ?`,
  ).run(firstIdx, id)
  addEvent(id, {
    who: actor,
    text: `restarted the ${phasesFor(kind)[phase]} phase${reason ? ': ' + reason : ''}`,
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
    target || (step?.kind === 'agent' ? (step.agent ?? '') : ''),
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

// HZ-435: which of the three plan sections an issue body lacks, in order. A
// heading with nothing under it counts as missing. parseIssueBody cannot
// answer this: it copies a heading-less body into desc. Read-only.
export const PLAN_SECTIONS = ['Outcome', 'Success metric', 'Guardrails']

export function missingPlanSections(body) {
  const text = (body || '').replace(/\r\n/g, '\n').trim()
  const present = new Set()
  for (const part of text.split(/^##\s+/m).slice(1)) {
    const newline = part.indexOf('\n')
    const heading = (newline === -1 ? part : part.slice(0, newline)).trim().toLowerCase()
    if (newline !== -1 && part.slice(newline + 1).trim()) present.add(heading)
  }
  return PLAN_SECTIONS.filter((name) => !present.has(name.toLowerCase()))
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

// HZ-449: `lane` is the lane a Plan's draft asked for; one the kind does not
// have is stored as no lane.
export function createLocalItem({ title, outcome, metric, guardrails, priority, kind, lane = null }) {
  // HZ-377: the kind defaults to `change`; anything outside the domain
  // vocabulary is refused before anything is written.
  const itemKind = kind ?? 'change'
  if (!isItemKind(itemKind)) return { error: 'unknown_item_kind' }
  const next =
    db
      .prepare("SELECT COALESCE(MAX(CAST(SUBSTR(id, 5) AS INTEGER)), 0) AS n FROM work_item WHERE id LIKE 'LOC-%'")
      .get().n + 1
  const id = `LOC-${next}`
  db.prepare(
    'INSERT INTO work_item (id, title, priority, desc, metric, guardrails, cursor, kind, lane) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, title, priority, outcome, metric, guardrails || '', firstStepIndex(itemKind), itemKind, laneOf({ kind: itemKind, lane }))
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

  db.prepare(`UPDATE work_item SET cursor = ?, rejected = 0, ${touch} WHERE id = ?`).run(nextCursor(it), id)
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
  markMerged(id)
  if (isClosed(getItem(id))) wakeDependents(id)
  return { ok: true }
}

// HZ-467: records that the item's PR merged to main, then wakes its
// dependents — their implement may start now, before the deploy and close.
// Called only after a merge succeeded: app.js after github.mergePr, and
// approveGateFromGithub for a PR merged on GitHub. A second call, or an
// unknown id, is a no-op: the first merge time stands.
export function markMerged(id) {
  const result = db.prepare(`UPDATE work_item SET merged_at = datetime('now'), ${touch} WHERE id = ? AND merged_at IS NULL`).run(id)
  if (result.changes === 0) return false
  notify()
  wakeDependents(id)
  return true
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
  // HZ-544: read on every sync, like the priority; the label is the switch.
  const autopilotOff = autopilotOffFromLabels(ghIssue.labels) ? 1 : 0
  const closedOnGithub = ghIssue.state === 'closed'
  const row = db.prepare('SELECT * FROM work_item WHERE repo = ? AND issue = ?').get(repoFullName, number)
  let changed = false

  if (!row) {
    // HZ-382: the kind is read off the labels here, on insert only — the update
    // branch below never touches it, so adding or removing `task` later does
    // not change an item's kind.
    const kind = kindFromLabels(ghIssue.labels)
    const id = `${repoRow.prefix}-${number}`
    db.prepare(
      'INSERT INTO work_item (id, title, priority, desc, metric, guardrails, issue, repo, project_id, cursor, kind, lane, autopilot_off) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      title,
      priority,
      desc,
      metric,
      guardrails,
      number,
      repoFullName,
      repoRow.project_id,
      closedOnGithub ? endIndex(kind) : firstStepIndex(kind),
      kind,
      laneFromLabels(ghIssue.labels, kind),
      autopilotOff,
    )
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
    if (autopilotOff !== (row.autopilot_off ? 1 : 0)) {
      db.prepare(`UPDATE work_item SET autopilot_off = ?, ${touch} WHERE id = ?`).run(autopilotOff, row.id)
      const text = autopilotOff
        ? `Autopilot turned off for this item (label ${AUTOPILOT_OFF_LABEL})`
        : `Autopilot handed this item back (label ${AUTOPILOT_OFF_LABEL} removed)`
      addEvent(row.id, { who: 'GitHub', text, color: '#2A2A2E', initials: 'GH' })
      changed = true
    }
    // HZ-435: unlike the kind, the lane follows the label until the item
    // passes its first gate (Approve & prioritize); from then on it is frozen,
    // so a label change never reroutes an item mid-plan.
    const kind = itemKindOf(row)
    if (row.cursor <= gateStepIndexes(STEPS, kind)[0]) {
      const lane = laneFromLabels(ghIssue.labels, kind)
      if (lane !== laneOf(row)) {
        db.prepare(`UPDATE work_item SET lane = ?, ${touch} WHERE id = ?`).run(lane, row.id)
        addEvent(row.id, { who: 'GitHub', text: `lane: ${lane ?? 'full'}`, color: '#2A2A2E', initials: 'GH' })
        changed = true
      }
    }
    const wasClosed = isClosed(row)
    // Both branches skip an already-abandoned item: closing the issue is
    // abandonItem's own best-effort side effect (would otherwise race to
    // reclassify the item as completed — see abandonItem above), and a
    // GitHub reopen must never silently resurrect an abandoned item mid-flight.
    if (closedOnGithub && !wasClosed && !row.abandoned_at) {
      agentRunner.cancel(row.id, 'cancelled')
      db.prepare(`UPDATE work_item SET cursor = ?, ${touch} WHERE id = ?`).run(endIndex(itemKindOf(row)), row.id)
      addEvent(row.id, { who: 'GitHub', text: `closed issue #${number}`, color: '#2A2A2E', initials: 'GH' })
      changed = true
      wakeDependents(row.id)
    } else if (!closedOnGithub && wasClosed && !row.abandoned_at) {
      // HZ-467: a reopened item starts over, so its old merge no longer counts.
      db.prepare(`UPDATE work_item SET cursor = ?, rejected = 0, paused = 0, merged_at = NULL, ${touch} WHERE id = ?`).run(
        firstStepIndex(itemKindOf(row)),
        row.id,
      )
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
  const rows = db.prepare('SELECT id, cursor, kind, lane FROM work_item WHERE rejected = 1').all()
  for (const row of rows) {
    const first = firstStepIndex(itemKindOf(row))
    let reworkIdx = Math.min(Math.max(row.cursor, first), endIndex(itemKindOf(row)) - 1)
    if (STEPS[reworkIdx].kind === 'gate') {
      // Same Accept-gate special case as requestChanges: don't land on the
      // automated Review step, which would just re-judge unchanged code.
      if (reworkIdx === ACCEPT_GATE_INDEX) {
        reworkIdx = IMPLEMENT_STEP_INDEX
      } else {
        const skips = laneSkips(row)
        while (reworkIdx > first && (STEPS[reworkIdx].kind !== 'agent' || isServerStep(reworkIdx) || skips.has(reworkIdx))) {
          reworkIdx--
        }
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
    const resetReview = itemKindOf(row) === 'change' && reworkIdx <= IMPLEMENT_STEP_INDEX ? RESET_REVIEW_STATE : ''
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
