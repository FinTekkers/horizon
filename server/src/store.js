// Domain operations over SQLite. Every mutation notifies subscribers so the
// HTTP layer can push fresh state to SSE clients.

import { db } from './db.js'
import { STEPS, PHASES, isClosed, curStep, IMPLEMENT_STEP_INDEX, ACCEPT_GATE_INDEX } from './lifecycle.js'
import { isPersona, personaLabel } from './personas.js'
import { getActiveProjectId, setSetting } from './settings.js'

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
let agentRunner = { kick: () => {}, cancel: () => {} }

export function registerAgentRunner(runner) {
  agentRunner = runner
}

// ---- projects & repos ----

export function listProjects() {
  const projects = db.prepare('SELECT * FROM project ORDER BY name').all()
  const repos = db.prepare('SELECT * FROM project_repo ORDER BY repo').all()
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    repos: repos.filter((r) => r.project_id === p.id).map((r) => ({ repo: r.repo, prefix: r.prefix })),
  }))
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
  const id = db.prepare('INSERT INTO project (name) VALUES (?)').run(name).lastInsertRowid
  // The first project becomes active without a farm restart — nothing was
  // running before it existed.
  if (getActiveProjectId() == null) setSetting('active_project_id', String(id))
  notify()
  return { ok: true, id, name }
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

const selectItems = db.prepare('SELECT * FROM work_item ORDER BY id')
const selectEvents = db.prepare('SELECT who, text, color, initials, created_at FROM event WHERE item_id = ? ORDER BY id DESC LIMIT 20')
const selectOutputs = db.prepare(
  "SELECT step_index, attempt, output, artifact FROM step_run WHERE item_id = ? AND status = 'done' ORDER BY id",
)

function stepOutputs(itemId) {
  const map = {}
  for (const row of selectOutputs.all(itemId)) {
    // last write wins = latest attempt; label so non-UI clients (the
    // WhatsApp concierge) can name the step without a STEPS copy
    map[row.step_index] = {
      output: row.output,
      attempt: row.attempt,
      artifact: row.artifact || null,
      label: STEPS[row.step_index]?.label ?? null,
    }
  }
  return map
}

// `id` rides along so the UI can tail the run's live log (HZ-5).
const selectActiveRun = db.prepare(
  "SELECT id, step_index, attempt, started_at FROM step_run WHERE item_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
)

// Where an item stands, resolved server-side so non-UI clients (the WhatsApp
// concierge) don't need their own copy of the STEPS table.
function currentStepOf(row) {
  if (isClosed(row)) return { index: row.cursor, label: 'Closed', kind: 'done', phase: 'Done', gate: false }
  const step = STEPS[row.cursor]
  return { index: row.cursor, label: step.label, kind: step.kind, phase: PHASES[step.phase], gate: step.kind === 'gate' }
}

// Board/tracker only ever see the active project's items (plus local demo
// items, which have no project). Other projects keep syncing in the
// background but are invisible until activated.
export function listItems() {
  const activeId = getActiveProjectId()
  return selectItems
    .all()
    .filter((row) => row.project_id == null || activeId == null || row.project_id === activeId)
    .map((row) => ({
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
    persona: row.persona,
    cursor: row.cursor,
    currentStep: currentStepOf(row),
    paused: !!row.paused,
    rejected: !!row.rejected,
    events: selectEvents.all(row.id),
    stepOutputs: stepOutputs(row.id),
    activeRun: selectActiveRun.get(row.id) || null,
  }))
}

export function getItem(id) {
  const row = db.prepare('SELECT * FROM work_item WHERE id = ?').get(id)
  if (!row) return null
  return { ...row, paused: !!row.paused, rejected: !!row.rejected }
}

// Human actions are only valid against the active project's items.
function inactiveProject(item) {
  const activeId = getActiveProjectId()
  return item.project_id != null && activeId != null && item.project_id !== activeId
}

// ---- mutations ----

const touch = "updated_at = datetime('now')"

export function addEvent(id, { who, text, color, initials }) {
  db.prepare('INSERT INTO event (item_id, who, text, color, initials) VALUES (?, ?, ?, ?, ?)').run(id, who, text, color, initials)
}

export function approveGate(id, stepIndex, notes, actor = 'You') {
  const it = getItem(id)
  if (!it) return { error: 'not_found' }
  if (inactiveProject(it)) return { error: 'project_not_active' }
  if (isClosed(it) || STEPS[it.cursor].kind !== 'gate') return { error: 'not_at_gate' }
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
  return { ok: true }
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
  if (inactiveProject(it)) return { error: 'project_not_active' }
  if (isClosed(it)) return { error: 'closed' }

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
  const resetReview = reworkIdx <= IMPLEMENT_STEP_INDEX ? ', review_cycle_count = 0' : ''
  db.prepare(`UPDATE work_item SET cursor = ?, rejected = 0, paused = 0${resetReview}, ${touch} WHERE id = ?`).run(reworkIdx, id)
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
  if (inactiveProject(it)) return { error: 'project_not_active' }
  if (isClosed(it)) return { error: 'closed' }

  db.prepare(`UPDATE work_item SET paused = ?, ${touch} WHERE id = ?`).run(paused ? 1 : 0, id)
  addEvent(id, {
    who: 'You',
    text: paused ? 'paused agent work on this item' : 'resumed work',
    color: '#5E4380',
    initials: 'YOU',
  })
  notify()
  if (paused) agentRunner.cancel(id, 'cancelled')
  else agentRunner.kick(id)
  return { ok: true }
}

// The human leg of specialist routing: confirm or override the persona the PM
// proposed (usually at the intake gate; the next dispatch reads the item).
export function setPersona(id, persona) {
  const it = getItem(id)
  if (!it) return { error: 'not_found' }
  if (inactiveProject(it)) return { error: 'project_not_active' }
  if (isClosed(it)) return { error: 'closed' }
  if (!isPersona(persona)) return { error: 'bad_persona' }

  db.prepare(`UPDATE work_item SET persona = ?, ${touch} WHERE id = ?`).run(persona, id)
  addEvent(id, {
    who: 'You',
    text: `set the specialist persona to ${personaLabel(persona)}`,
    color: '#5E4380',
    initials: 'YOU',
  })
  notify()
  return { ok: true }
}

// Priority changes arrive from the UI or the WhatsApp concierge; either way
// it is the human speaking. GitHub label mirroring lives in the route (best
// effort) — this only owns the database and the activity trail.
export const PRIORITIES = ['Critical', 'High', 'Medium', 'Low']

export function setPriority(id, priority) {
  const it = getItem(id)
  if (!it) return { error: 'not_found' }
  if (inactiveProject(it)) return { error: 'project_not_active' }
  if (isClosed(it)) return { error: 'closed' }
  if (!PRIORITIES.includes(priority)) return { error: 'bad_priority' }
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
  if (inactiveProject(it)) return { error: 'project_not_active' }
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
  const resetReview = firstIdx <= IMPLEMENT_STEP_INDEX ? ', review_cycle_count = 0' : ''
  db.prepare(`UPDATE work_item SET cursor = ?, rejected = 0, paused = 0${resetReview}, ${touch} WHERE id = ?`).run(firstIdx, id)
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

// Standalone feedback (UI form or an ingested GitHub comment). If the item is
// sitting on an agent step and not paused, the in-flight run is superseded and
// the step re-runs (attempt N+1) with this feedback injected; otherwise the
// row waits (delivered_at NULL) for the next dispatch — dispatchToFarm picks
// up all undelivered rows. Rejection feedback still flows via requestChanges.
export function addFeedback(id, { message, target = '', source = 'ui', ghCommentId = null }) {
  const it = getItem(id)
  if (!it) return { error: 'not_found' }
  if (inactiveProject(it)) return { error: 'project_not_active' }
  if (isClosed(it)) return { error: 'closed' }

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

// Remove the BF-* demo items (called when real GitHub sync is connected).
export function purgeDemoItems() {
  const ids = db.prepare("SELECT id FROM work_item WHERE id LIKE 'BF-%'").all().map((r) => r.id)
  if (ids.length === 0) return
  ids.forEach((id) => agentRunner.cancel(id, 'cancelled'))
  db.transaction(() => {
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
  result.desc = result.desc.slice(0, 500)
  return result
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
  if (isClosed(it) || STEPS[stepIndex]?.label !== 'Accept the code') return { error: 'not_at_accept_gate' }

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
  return { ok: true }
}

// ---- GitHub sync ----
// Shared upsert used by both the webhook handler and the poller. GitHub owns
// title/description/priority/open-closed; the lifecycle state (cursor, flags,
// metric, guardrails) stays ours and is never clobbered by a sync.

const PRIORITY_LABEL = /^(?:priority\s*[:/-]?\s*)?(critical|high|medium|low)$/i

function priorityFromLabels(labels) {
  for (const label of labels || []) {
    const match = PRIORITY_LABEL.exec(label?.name || '')
    if (match) return match[1][0].toUpperCase() + match[1].slice(1).toLowerCase()
  }
  return 'Medium'
}

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
    if (closedOnGithub && !wasClosed) {
      agentRunner.cancel(row.id, 'cancelled')
      db.prepare(`UPDATE work_item SET cursor = ?, ${touch} WHERE id = ?`).run(STEPS.length, row.id)
      addEvent(row.id, { who: 'GitHub', text: `closed issue #${number}`, color: '#2A2A2E', initials: 'GH' })
      changed = true
    } else if (!closedOnGithub && wasClosed) {
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
    const resetReview = reworkIdx <= IMPLEMENT_STEP_INDEX ? ', review_cycle_count = 0' : ''
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
