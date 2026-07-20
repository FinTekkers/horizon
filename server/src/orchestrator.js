// The agent orchestrator: runs agent-kind steps for any item whose cursor
// points at one, records every attempt as a step_run, logs an activity event
// with the agent's output, then advances the cursor and stops at the next
// human gate.
//
// Agents are MOCKED for now — each step behavior below fakes latency and
// produces a plausible output (and sometimes patches draft fields the Plan
// phase is meant to produce). The target state replaces runMockStep() with a
// dispatch to a real agent in a tmux session reporting progress back; the
// step_run/event bookkeeping and gate semantics stay exactly as they are.

import { db } from './db.js'
import { STEPS, AGENTS, isClosed } from './lifecycle.js'
import { getItem, addEvent, notifyChange, registerAgentRunner, recoverRejectedItems } from './store.js'
import { createMockPr, createDeployRelease, postIssueComment, createPrFromBranch } from './github.js'
import { PHASES } from './lifecycle.js'
import { getActiveProjectId, getSetting, setSetting, getToken } from './settings.js'
import { FARM_URL, FARM_STEP_INDEXES, FARM_STEP_TIMEOUT_MS, FARM_START_TIMEOUT_MS, UI_URL } from './config.js'

const timers = {}

const latency = () => 2000 + Math.floor(Math.random() * 3000)

// ---- bot farm lifecycle ----
// The farm runs with ONE project's context at a time. Switching projects
// tears the agents down and restarts them with the new context — mocked here
// with a delay (the real farm spin-up will take minutes).

const RESTART_MS = Number(process.env.FARM_RESTART_MS || 8000)

let farm = { status: 'running', since: new Date().toISOString() }

export function getFarmState() {
  return { ...farm, activeProjectId: getActiveProjectId() }
}

// ---- real farm (farm/ Python daemon) plumbing ----

async function farmFetch(path, body) {
  const res = await fetch(`${FARM_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `farm returned ${res.status} for ${path}`)
  return data
}

function projectPayload(projectId) {
  const project = db.prepare('SELECT * FROM project WHERE id = ?').get(projectId)
  const repos = db.prepare('SELECT repo, prefix FROM project_repo WHERE project_id = ?').all(projectId)
  return { project: { id: project.id, name: project.name }, repos, token: getToken() }
}

async function waitForFarmRunning() {
  const deadline = Date.now() + FARM_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const status = await farmFetch('/farm/status')
    if (status.status === 'running') return
    if (status.status === 'error') throw new Error(`farm failed to start: ${status.error}`)
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  throw new Error('farm did not become ready in time')
}

async function startRealFarm(projectId, log) {
  farm = { status: 'restarting', since: new Date().toISOString() }
  notifyChange()
  try {
    await farmFetch('/farm/start', projectPayload(projectId))
    await waitForFarmRunning()
    farm = { status: 'running', since: new Date().toISOString() }
    const resumed = resumeActiveItems()
    log?.info(`Farm up for project ${projectId}; resumed ${resumed} item(s)`)
  } catch (err) {
    log?.warn(`Farm start failed: ${err.message}`)
    farm = { status: 'error', error: err.message, since: new Date().toISOString() }
  }
  notifyChange()
}

// Called at boot and when the active project's farm should exist but doesn't.
export function ensureFarm(log) {
  if (!FARM_URL) return
  const activeId = getActiveProjectId()
  if (!activeId || farm.status === 'restarting') return
  if (farm.status === 'running' && farm.projectId === activeId) return
  farm.projectId = activeId
  startRealFarm(activeId, log).then(() => {
    farm.projectId = activeId
  })
}

export function switchProject(projectId, log) {
  // Agents down: cancel every in-flight step across all items.
  for (const id of Object.keys(timers)) cancel(id, 'superseded')
  setSetting('active_project_id', String(projectId))

  if (FARM_URL) {
    farm.projectId = projectId
    ;(async () => {
      try {
        await farmFetch('/farm/stop', {})
      } catch {
        // farm may already be down; start will surface real problems
      }
      await startRealFarm(projectId, log)
    })()
    return
  }

  // No real farm configured: simulate the restart as before.
  farm = { status: 'restarting', since: new Date().toISOString() }
  notifyChange()
  log?.info(`Bot farm restarting with project ${projectId} context (${RESTART_MS}ms simulated)`)
  setTimeout(() => {
    farm = { status: 'running', since: new Date().toISOString() }
    const resumed = resumeActiveItems()
    log?.info(`Bot farm up for project ${projectId}; resumed ${resumed} item(s)`)
    notifyChange()
  }, RESTART_MS).unref()
}

function projectActive(item) {
  const activeId = getActiveProjectId()
  return item.project_id == null || activeId == null || item.project_id === activeId
}

function resumeActiveItems() {
  let resumed = 0
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) {
    const item = getItem(id)
    if (runnable(item)) {
      kick(id)
      resumed++
    }
  }
  return resumed
}

// Mock behavior per step index (the pipeline is fixed — see lifecycle.js).
// Returns { summary, patch? } where patch updates work_item fields, mimicking
// the artifacts each agent is supposed to produce.
const MOCK_STEP_BEHAVIOR = {
  0: (it) =>
    it.desc
      ? { summary: 'refined the outcome statement from the issue description' }
      : { summary: 'drafted an outcome statement for gate review', patch: { desc: `Deliver: ${it.title}` } },
  1: (it) =>
    it.metric
      ? { summary: 'validated the success metric is measurable' }
      : {
          summary: 'drafted a success metric for gate review',
          patch: { metric: `Draft — define a measurable target for “${it.title}” (confirm at the gate)` },
        },
  2: (it) =>
    it.guardrails
      ? { summary: 'confirmed guardrails; defaults also apply' }
      : {
          summary: 'set draft guardrails',
          patch: { guardrails: 'Draft — defaults apply: tests, linters and e2e must pass; no destructive data changes.' },
        },
  4: () => ({ summary: 'prepared options A/B/C with trade-offs; recommends B (robust, medium effort)' }),
  6: () => ({ summary: 'drafted the implementation plan: components touched, sequencing, test impact' }),
  7: () => ({ summary: 'architecture review passed — no encapsulation or duplication concerns' }),
  8: () => ({ summary: 'test plan covers the success metric; added two edge cases' }),
  // Execute: the code change takes the form of a GitHub PR. The mock commits
  // a placeholder file; the PR/branch mechanics are the real integration.
  10: async (it) => {
    if (!it.repo || it.issue == null) {
      return { summary: 'implementation complete on a feature branch; all checks green (no GitHub — PR skipped)' }
    }
    if (it.pr != null) {
      return { summary: `implementation updated — PR #${it.pr} still open for review` }
    }
    try {
      const pr = await createMockPr(it)
      return {
        summary: `implementation complete — opened PR #${pr.number} for the “Accept the code” gate`,
        patch: { pr: pr.number, pr_url: pr.html_url },
      }
    } catch (err) {
      return { summary: `implementation complete, but opening the PR failed: ${err.message}` }
    }
  },
  // Deploy: publish a GitHub Release, which triggers the (self-provisioned)
  // Horizon Deploy workflow. The mock is the deploy content, not the plumbing.
  12: async (it) => {
    if (!it.repo || it.issue == null) {
      return { summary: 'deployed to the target environment; smoke checks passed (no GitHub — release skipped)' }
    }
    try {
      const release = await createDeployRelease(it)
      return {
        summary: `published release ${release.tag_name}${release.addedWorkflow ? ' (and added the Horizon Deploy workflow to the repo)' : ''} — the deploy workflow is running`,
        patch: { release_tag: release.tag_name, release_url: release.html_url },
      }
    } catch (err) {
      return { summary: `deploy simulated, but publishing the release failed: ${err.message}` }
    }
  },
}

function runnable(item) {
  return (
    farm.status === 'running' &&
    item &&
    projectActive(item) &&
    !isClosed(item) &&
    !item.paused &&
    !item.rejected &&
    STEPS[item.cursor].kind === 'agent'
  )
}

export function kick(id) {
  const item = getItem(id)
  if (!runnable(item) || timers[id]) return

  const stepIndex = item.cursor
  const step = STEPS[stepIndex]
  const attempt =
    db.prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM step_run WHERE item_id = ? AND step_index = ?').get(
      id,
      stepIndex,
    ).n
  const runId = db
    .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, ?, ?)')
    .run(id, stepIndex, attempt, step.agent).lastInsertRowid

  if (FARM_URL && FARM_STEP_INDEXES.has(stepIndex)) {
    dispatchToFarm(id, stepIndex, runId, attempt)
  } else {
    timers[id] = setTimeout(() => runMockStep(id, stepIndex, runId), latency())
  }
}

// ---- farm-dispatched steps ----

function dispatchToFarm(id, stepIndex, runId, attempt) {
  const step = STEPS[stepIndex]
  const item = getItem(id)
  // Undelivered human feedback rides along and is considered delivered.
  const feedback = db
    .prepare('SELECT message, target, created_at FROM feedback WHERE item_id = ? AND delivered_at IS NULL')
    .all(id)
  if (feedback.length > 0) {
    db.prepare("UPDATE feedback SET delivered_at = datetime('now') WHERE item_id = ? AND delivered_at IS NULL").run(id)
  }

  // Watchdog: if the farm never reports back, fail the run rather than hang.
  // The implement step legitimately runs long (real coding + tests) — its
  // watchdog must outlast the farm's own 40-minute step timeout.
  const watchdogMs = stepIndex === 10 ? Math.max(FARM_STEP_TIMEOUT_MS, 50 * 60 * 1000) : FARM_STEP_TIMEOUT_MS
  timers[id] = setTimeout(() => failFarmRun(runId, 'step timed out waiting for the farm'), watchdogMs)

  // Prior artifacts (options analysis, impl plan, reviews) give later agents
  // their working context — the implement step reads the approved plan.
  const artifacts = db
    .prepare(
      "SELECT step_index, artifact FROM step_run WHERE item_id = ? AND status = 'done' AND artifact IS NOT NULL ORDER BY id",
    )
    .all(id)
    .map((row) => ({ label: STEPS[row.step_index]?.label || `step ${row.step_index}`, content: row.artifact.slice(0, 4000) }))

  farmFetch('/steps/run', {
    run_id: runId,
    attempt,
    artifacts,
    item: {
      id: item.id,
      title: item.title,
      desc: item.desc,
      metric: item.metric,
      guardrails: item.guardrails,
      priority: item.priority,
      repo: item.repo,
      issue: item.issue,
    },
    step: { index: stepIndex, label: step.label, agent: step.agent },
    feedback,
  }).catch((err) => {
    failFarmRun(runId, `could not hand the step to the farm: ${err.message}`)
  })
}

const FARM_PATCH_FIELDS = ['desc', 'metric', 'guardrails']
const PATCH_FIELD_LABELS = { desc: 'Outcome', metric: 'Success metric', guardrails: 'Guardrails' }

// Every completed agent step is mirrored onto the GitHub issue — the issue
// thread is the human-readable record of what the bots did.
function postStepComment(item, stepIndex, attempt, summary, patch, isMock, artifactMd) {
  if (!item.repo || item.issue == null) return
  const step = STEPS[stepIndex]
  const agent = AGENTS[step.agent]
  const lines = [`### 🤖 ${agent.label} — ${step.label}`, '', summary]
  const changed = Object.keys(patch || {}).filter((k) => PATCH_FIELD_LABELS[k])
  if (changed.length > 0) {
    lines.push('', '**Updated fields:**')
    for (const key of changed) lines.push(`- **${PATCH_FIELD_LABELS[key]}:** ${patch[key]}`)
  }
  if (artifactMd) {
    lines.push('', '---', '', artifactMd.slice(0, 60000)) // GitHub's comment cap is 65536
  }
  lines.push(
    '',
    `_${PHASES[step.phase]} phase · attempt ${attempt}${isMock ? ' · mock agent' : ''} · [open in Horizon](${UI_URL}/${item.id.toLowerCase()}) · posted by Horizon_`,
  )
  postIssueComment(item, lines.join('\n')).catch((err) => {
    addEvent(item.id, {
      who: 'Horizon',
      text: `could not post the step result to issue #${item.issue}: ${err.message}`,
      color: '#9C333E',
      initials: 'HZ',
    })
    notifyChange()
  })
}

export async function completeFarmRun(runId, { summary, patch, artifacts }) {
  const run = db.prepare('SELECT * FROM step_run WHERE id = ?').get(runId)
  if (!run || run.status !== 'active') return { ok: true, stale: true }
  const id = run.item_id
  const item = getItem(id)

  clearTimeout(timers[id])
  delete timers[id]

  if (!item || item.cursor !== run.step_index || !runnable(item)) {
    closeActiveRuns(id, 'superseded')
    return { ok: true, stale: true }
  }

  const cleanPatch = {}
  for (const field of FARM_PATCH_FIELDS) {
    if (typeof patch?.[field] === 'string' && patch[field].trim()) cleanPatch[field] = patch[field].trim()
  }
  if (Object.keys(cleanPatch).length > 0) {
    const fields = Object.keys(cleanPatch)
    db.prepare(
      `UPDATE work_item SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    ).run(...fields.map((f) => cleanPatch[f]), id)
  }

  const step = STEPS[run.step_index]
  const agent = AGENTS[step.agent]
  let text = String(summary || 'completed the step').slice(0, 600)

  // The implement step's artifact is a pushed branch: this side owns turning
  // it into the PR. If that fails, the step fails — no PR, no advance.
  if (typeof artifacts?.branch === 'string' && item.repo && item.issue != null) {
    try {
      const pr = await createPrFromBranch(item, artifacts.branch)
      db.prepare("UPDATE work_item SET pr = ?, pr_url = ?, updated_at = datetime('now') WHERE id = ?").run(
        pr.number,
        pr.html_url,
        id,
      )
      text = `${text} — opened PR #${pr.number}${artifacts.files_changed ? ` (${artifacts.files_changed})` : ''}`.slice(0, 700)
    } catch (err) {
      return failFarmRun(runId, `code pushed to ${artifacts.branch} but the PR could not be opened: ${err.message}`)
    }
  }

  const artifactMd = typeof artifacts?.artifact_md === 'string' ? artifacts.artifact_md.slice(0, 12000) : null
  db.prepare("UPDATE step_run SET status = 'done', output = ?, artifact = ?, ended_at = datetime('now') WHERE id = ?").run(
    text,
    artifactMd,
    runId,
  )
  db.prepare("UPDATE work_item SET cursor = cursor + 1, updated_at = datetime('now') WHERE id = ?").run(id)
  addEvent(id, { who: agent.label, text: `completed “${step.label}” — ${text.slice(0, 300)}`, color: agent.color, initials: agent.initials })
  postStepComment(getItem(id), run.step_index, run.attempt, text, cleanPatch, false, artifactMd)
  notifyChange()
  kick(id)
  return { ok: true }
}

export function failFarmRun(runId, error) {
  const run = db.prepare('SELECT * FROM step_run WHERE id = ?').get(runId)
  if (!run || run.status !== 'active') return { ok: true, stale: true }
  const id = run.item_id

  clearTimeout(timers[id])
  delete timers[id]

  // No 'failed' status in older DBs' CHECK constraint — record as cancelled
  // with a FAILED-prefixed output, pause the item for a human, and say why.
  db.prepare(
    "UPDATE step_run SET status = 'cancelled', output = ?, ended_at = datetime('now') WHERE id = ?",
  ).run(`FAILED: ${String(error).slice(0, 300)}`, runId)
  db.prepare("UPDATE work_item SET paused = 1, updated_at = datetime('now') WHERE id = ?").run(id)
  addEvent(id, {
    who: 'Horizon',
    text: `agent step failed: ${String(error).slice(0, 200)} — item paused; resume to retry`,
    color: '#9C333E',
    initials: 'HZ',
  })
  notifyChange()
  return { ok: true }
}

// A run only completes if its own step_run row is still active — cancel/
// reject/restart flip that row's status, which safely no-ops the in-flight run
// even if it was mid-await (e.g. creating a PR) when the human acted.
function runStillActive(runId) {
  return db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId)?.status === 'active'
}

async function runMockStep(id, stepIndex, runId) {
  // timers[id] stays set (as a "busy" marker) until this run fully exits, so
  // a concurrent kick() can't start a duplicate run across the awaits below.
  const item = getItem(id)
  // Re-validate: the world may have changed while the "agent" was working.
  if (!runnable(item) || item.cursor !== stepIndex || !runStillActive(runId)) {
    delete timers[id]
    closeActiveRuns(id, 'superseded')
    return
  }

  const step = STEPS[stepIndex]
  const agent = AGENTS[step.agent]
  const behavior = MOCK_STEP_BEHAVIOR[stepIndex] || (() => ({ summary: `completed ${step.label.toLowerCase()}` }))
  let { summary, patch } = await behavior(item)

  // Deliver any queued human feedback to this "agent" — the mock acknowledges
  // it in its output; a real agent gets it injected into its session.
  const pendingFeedback = db
    .prepare('SELECT id, message FROM feedback WHERE item_id = ? AND delivered_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(id)
  if (pendingFeedback) {
    db.prepare("UPDATE feedback SET delivered_at = datetime('now') WHERE item_id = ? AND delivered_at IS NULL").run(id)
    summary = `addressed your feedback (“${pendingFeedback.message.slice(0, 80)}”) — ${summary}`
  }

  // Re-check after any await (e.g. PR creation): a pause/reject may have landed.
  const after = getItem(id)
  if (!runnable(after) || after.cursor !== stepIndex || !runStillActive(runId)) {
    delete timers[id]
    if (runStillActive(runId)) closeActiveRuns(id, 'superseded')
    return
  }

  if (patch) {
    const fields = Object.keys(patch)
    db.prepare(`UPDATE work_item SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(
      ...fields.map((f) => patch[f]),
      id,
    )
  }
  db.prepare("UPDATE step_run SET status = 'done', output = ?, ended_at = datetime('now') WHERE id = ?").run(
    summary,
    runId,
  )
  db.prepare("UPDATE work_item SET cursor = cursor + 1, updated_at = datetime('now') WHERE id = ?").run(id)
  addEvent(id, {
    who: agent.label,
    text: `completed “${step.label}” — ${summary}`,
    color: agent.color,
    initials: agent.initials,
  })
  const attempt = db.prepare('SELECT attempt FROM step_run WHERE id = ?').get(runId)?.attempt || 1
  postStepComment(getItem(id), stepIndex, attempt, summary, patch, true)
  notifyChange()
  delete timers[id]
  kick(id) // next step, until a gate/closure
}

function closeActiveRuns(id, status) {
  db.prepare("UPDATE step_run SET status = ?, ended_at = datetime('now') WHERE item_id = ? AND status = 'active'").run(
    status,
    id,
  )
}

// Called by the store when a human halts work mid-step. The farm is told to
// kill the run's session too — a superseded attempt must not keep burning
// tokens or race its replacement on the shared horizon/<item-id> branch.
export function cancel(id, status = 'cancelled') {
  const activeRuns = db.prepare("SELECT id FROM step_run WHERE item_id = ? AND status = 'active'").all(id)
  clearTimeout(timers[id])
  delete timers[id]
  closeActiveRuns(id, status)
  if (FARM_URL) {
    for (const run of activeRuns) {
      farmFetch('/steps/cancel', { run_id: run.id }).catch(() => {})
    }
  }
}

export function init(log) {
  registerAgentRunner({ kick, cancel })
  // Default the active project to the first one if never chosen.
  if (!getSetting('active_project_id')) {
    const first = db.prepare('SELECT id FROM project ORDER BY id LIMIT 1').get()
    if (first) setSetting('active_project_id', String(first.id))
  }
  if (FARM_URL) {
    // Farm runs SURVIVE a server restart — the agents live in tmux, not in
    // this process. Re-arm their watchdogs instead of superseding them.
    const rearmed = rearmFarmRuns()
    if (rearmed > 0) log.info(`Re-armed watchdogs for ${rearmed} in-flight farm run(s)`)
  } else {
    // Mock runs die with this process: close them; resume will re-kick.
    closeAllOrphanedRuns()
  }
  const recovered = recoverRejectedItems()
  if (recovered > 0) log.info(`Requeued ${recovered} rejected item(s) for rework`)
  if (FARM_URL) {
    // Real farm: don't resume items until the farm reports ready.
    ensureFarm(log)
  } else {
    const resumed = resumeActiveItems()
    if (resumed > 0) log.info(`Orchestrator resumed ${resumed} item(s) mid-agent-step`)
  }
}

function rearmFarmRuns() {
  const active = db.prepare("SELECT id, item_id, step_index FROM step_run WHERE status = 'active'").all()
  for (const run of active) {
    const watchdogMs = run.step_index === 10 ? Math.max(FARM_STEP_TIMEOUT_MS, 50 * 60 * 1000) : FARM_STEP_TIMEOUT_MS
    timers[run.item_id] = setTimeout(() => failFarmRun(run.id, 'step timed out waiting for the farm'), watchdogMs)
  }
  return active.length
}

function closeAllOrphanedRuns() {
  db.prepare("UPDATE step_run SET status = 'superseded', ended_at = datetime('now') WHERE status = 'active'").run()
}
