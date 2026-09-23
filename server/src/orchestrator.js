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
import { STEPS, AGENTS, isClosed, isAbandoned, IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX, DEPLOY_STEP_INDEX } from './lifecycle.js'
import { getItem, addEvent, notifyChange, registerAgentRunner, recoverRejectedItems } from './store.js'
import { createMockPr, createDeployRelease, postIssueComment, createPrFromBranch } from './github.js'
import { PHASES } from './lifecycle.js'
import { getActiveProjectId, getSetting, setSetting, getToken } from './settings.js'
import { FARM_URL, FARM_STEP_INDEXES, FARM_STEP_TIMEOUT_MS, FARM_START_TIMEOUT_MS, UI_URL } from './config.js'
import { isPersona, personaLabel, proposePersona } from './personas.js'

const timers = {}

// Hard cap enforced HERE, by the orchestrator, never by an agent prompt — a
// reviewer that keeps failing forwards the item to the human gate with the
// failing verdict attached rather than looping forever (HZ-30).
const REVIEW_CYCLE_CAP = 3

// MOCK_STEP_LATENCY_MS lets tests drive the mock pipeline without waiting.
const latency = () => Number(process.env.MOCK_STEP_LATENCY_MS) || 2000 + Math.floor(Math.random() * 3000)

// ---- bot farm lifecycle ----
// The farm runs with ONE project's context at a time. Switching projects
// tears the agents down and restarts them with the new context — mocked here
// with a delay (the real farm spin-up will take minutes).

const RESTART_MS = Number(process.env.FARM_RESTART_MS || 8000)

// ---- artifact prompt budget (HZ-29) ----
// Prior artifacts (options analysis, impl plan, reviews) ride along in every
// dispatch to give the next agent its working context. Two failure modes:
// superseded attempts of a re-run step riding along next to the current one,
// and a flat per-artifact slice silently cutting a large document off
// mid-sentence. The budget below bounds the dispatched total (agents have
// context limits) while giving the *latest* artifact — almost always the one
// the next step actually needs in full — the dominant share.
const TOTAL_ARTIFACT_BUDGET_CHARS = 60000
const MIN_OLDER_ARTIFACT_CHARS = 3000
// Write-side: a pathological-payload guard, not a working limit — mirrors the
// farm-side WRITE_ARTIFACT_SANITY_CEILING_CHARS. The dispatch-time budget
// above is what actually bounds the prompt.
const WRITE_TIME_SANITY_CEILING_CHARS = 200000

// Exported for tests: splits a total budget across prior artifacts, latest
// last (dispatch order is oldest-first). The latest gets whatever isn't
// reserved for older ones; older ones split a capped reserve evenly. Any
// artifact that doesn't fit its cap is hard-truncated with a visible marker.
export function budgetArtifacts(rows) {
  if (rows.length === 0) return []
  const olderCount = rows.length - 1
  const reservedForOlder = Math.min(olderCount * MIN_OLDER_ARTIFACT_CHARS, Math.floor(TOTAL_ARTIFACT_BUDGET_CHARS * 0.4))
  const latestCap = TOTAL_ARTIFACT_BUDGET_CHARS - reservedForOlder
  const olderCap = olderCount ? Math.floor(reservedForOlder / olderCount) : 0
  return rows.map((row, i) => {
    const cap = i === rows.length - 1 ? latestCap : olderCap
    const full = row.artifact
    const truncated = full.length > cap
    const content = truncated
      ? `${full.slice(0, cap)}\n\n[...truncated ${full.length - cap} of ${full.length} chars...]`
      : full
    return { label: STEPS[row.step_index]?.label || `step ${row.step_index}`, content, truncated, stepIndex: row.step_index }
  })
}

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

// Live log tail for a farm run (HZ-5): farmd serves the tmux pipe-pane
// mirror, paged by byte offset. Returns { status, data } so the route can
// pass the farm's own status (200/404) through; throws when the farm itself
// is unreachable.
export async function fetchRunLog(runId, offset = 0) {
  const res = await fetch(`${FARM_URL}/runs/${runId}/log?offset=${encodeURIComponent(offset)}`)
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
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

// Lets tests/e2e specs drive the mock review through the fail-then-retry-
// then-pass loop deterministically: fails the first N cycles (counted from
// work_item.review_cycle_count, the same counter the real cap enforcement
// reads), then passes. 0 (default) never fails.
const MOCK_REVIEW_FAIL_COUNT = Number(process.env.MOCK_REVIEW_FAIL_COUNT) || 0

const MOCK_QA_PASS = { verdict: 'pass', regression_tests_run: true, new_code_unit_coverage: true, e2e_test_present: true, findings: [] }

// Mock behavior per step index (the pipeline is fixed — see lifecycle.js).
// Returns { summary, patch? } where patch updates work_item fields, mimicking
// the artifacts each agent is supposed to produce.
export const MOCK_STEP_BEHAVIOR = {
  0: (it) => {
    const result = it.desc
      ? { summary: 'refined the outcome statement from the issue description', patch: {} }
      : { summary: 'drafted an outcome statement for gate review', patch: { desc: `Deliver: ${it.title}` } }
    // Propose a specialist persona once; never re-propose over a set value —
    // it may be a human's choice (the server-side no-clobber is the real guard).
    if (!it.persona) {
      result.patch.persona = proposePersona(it)
      result.summary += ` — proposed the ${personaLabel(result.patch.persona)} persona (confirm at the gate)`
    }
    if (Object.keys(result.patch).length === 0) delete result.patch
    return result
  },
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
  // The digest must never imply a decision — in demo mode there is no real PM
  // review, and only the human decides at the gate that follows.
  9: () => ({ summary: 'review digest unavailable in demo mode — a human must decide at the next gate' }),
  // Execute: the code change takes the form of a GitHub PR. The mock commits
  // a placeholder file; the PR/branch mechanics are the real integration.
  11: async (it) => {
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
  // Automated review (HZ-30): read-only code + QA review of the diff the
  // implement step just produced. MOCK_REVIEW_FAIL_COUNT makes this
  // deterministically fail its first N cycles (driven by the same
  // review_cycle_count column the real cap enforcement reads), so the
  // fail -> re-implement -> pass loop is exercisable without a real farm.
  12: (it) => {
    if ((it.review_cycle_count || 0) < MOCK_REVIEW_FAIL_COUNT) {
      return {
        summary: 'automated review found a guardrail violation — sent back to implement (mock)',
        verdict: {
          code_review: {
            verdict: 'fail',
            findings: [{ file: '(mock)', line: 1, severity: 'block', detail: 'mock guardrail violation for loop testing' }],
          },
          qa_review: MOCK_QA_PASS,
        },
      }
    }
    return {
      summary: 'automated review passed — code and QA both clear (mock)',
      verdict: { code_review: { verdict: 'pass', findings: [] }, qa_review: MOCK_QA_PASS },
    }
  },
  // Deploy: publish a GitHub Release, which the self-deploy webhook
  // (server/src/deploy.js) picks up to pull the tag onto shoreward.ai. The
  // mock is the deploy content, not the plumbing.
  14: async (it) => {
    if (!it.repo || it.issue == null) {
      return { summary: 'deployed to the target environment; smoke checks passed (no GitHub — release skipped)' }
    }
    try {
      const release = await createDeployRelease(it)
      return {
        summary: `published release ${release.tag_name}${release.addedWorkflow ? ' (and added the Horizon Deploy workflow to the repo)' : ''} — the self-deploy webhook will pull it to shoreward.ai`,
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
    !isAbandoned(item) &&
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

async function dispatchToFarm(id, stepIndex, runId, attempt) {
  const step = STEPS[stepIndex]
  let item = getItem(id)

  // Watchdog: if the farm never reports back, fail the run rather than hang.
  // The implement step legitimately runs long (real coding + tests) — its
  // watchdog must outlast the farm's own 40-minute step timeout.
  const watchdogMs = stepIndex === IMPLEMENT_STEP_INDEX ? Math.max(FARM_STEP_TIMEOUT_MS, 50 * 60 * 1000) : FARM_STEP_TIMEOUT_MS
  timers[id] = setTimeout(() => failFarmRun(runId, 'step timed out waiting for the farm'), watchdogMs)

  // Deploy's real side effect — publishing the GitHub release that the
  // self-deploy webhook picks up — needs the GitHub token, which only this
  // Node process holds; the farm never gets it. So this side publishes the
  // release itself, BEFORE handing the step to the farm, and the farm's
  // DevOps agent only does what it actually has the credentials and tools
  // for: deep post-deploy verification of the already-published release.
  let releaseFields = {}
  if (stepIndex === DEPLOY_STEP_INDEX && item.repo && item.issue != null) {
    try {
      const release = await createDeployRelease(item)
      releaseFields = { release_tag: release.tag_name, release_url: release.html_url }
      db.prepare("UPDATE work_item SET release_tag = ?, release_url = ?, updated_at = datetime('now') WHERE id = ?").run(
        release.tag_name,
        release.html_url,
        id,
      )
    } catch (err) {
      return failFarmRun(runId, `publishing the release failed: ${err.message}`)
    }
    // The world may have changed while awaiting the GitHub call (a human
    // could have cancelled/rejected the item) — re-check before dispatching.
    if (!runStillActive(runId)) return
    item = getItem(id)
  }

  // Undelivered human feedback rides along and is considered delivered.
  const feedback = db
    .prepare('SELECT message, target, created_at FROM feedback WHERE item_id = ? AND delivered_at IS NULL')
    .all(id)
  if (feedback.length > 0) {
    db.prepare("UPDATE feedback SET delivered_at = datetime('now') WHERE item_id = ? AND delivered_at IS NULL").run(id)
  }

  // Prior artifacts (options analysis, impl plan, reviews) give later agents
  // their working context — the implement step reads the approved plan, and
  // the review step reads the implement step's check-runner evidence (its
  // pass/fail note lives in step_run.output, not artifact, since implement
  // never sets artifact — without the OR clause the QA reviewer would never
  // see proof that regression tests actually ran). Keep only the
  // most-recently-completed row per step_index: a re-run step's superseded
  // attempt must not ride along next to the current one.
  const rows = db
    .prepare(
      `SELECT step_index, artifact, output FROM step_run
       WHERE item_id = ? AND status = 'done' AND (artifact IS NOT NULL OR step_index = ?)
         AND id IN (
           SELECT MAX(id) FROM step_run
           WHERE item_id = ? AND status = 'done' AND (artifact IS NOT NULL OR step_index = ?)
           GROUP BY step_index
         )
       ORDER BY id`,
    )
    .all(id, IMPLEMENT_STEP_INDEX, id, IMPLEMENT_STEP_INDEX)
    .map((row) => ({ step_index: row.step_index, artifact: row.artifact ?? row.output ?? '' }))
  const budgeted = budgetArtifacts(rows)
  const artifacts = budgeted.map(({ label, content }) => ({ label, content }))
  const truncatedLabels = budgeted.filter((a) => a.truncated).map((a) => a.label)
  if (truncatedLabels.length > 0) {
    addEvent(id, {
      who: 'Horizon',
      text: `artifact truncated for context budget: ${truncatedLabels.join(', ')}`,
      color: '#9C333E',
      initials: 'HZ',
    })
  }

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
      persona: item.persona,
      ...releaseFields,
    },
    step: { index: stepIndex, label: step.label, agent: step.agent },
    feedback,
  }).catch((err) => {
    failFarmRun(runId, `could not hand the step to the farm: ${err.message}`)
  })
}

const FARM_PATCH_FIELDS = ['desc', 'metric', 'guardrails', 'persona']
const PATCH_FIELD_LABELS = { desc: 'Outcome', metric: 'Success metric', guardrails: 'Guardrails', persona: 'Specialist persona' }

// Exported for tests: the comment body is the human-readable record, so its
// rendering (e.g. persona labels, never raw ids) is pinned directly.
export function stepCommentBody(item, stepIndex, attempt, summary, patch, isMock, artifactMd) {
  const step = STEPS[stepIndex]
  const agent = AGENTS[step.agent]
  const lines = [`### 🤖 ${agent.label} — ${step.label}`, '', summary]
  const changed = Object.keys(patch || {}).filter((k) => PATCH_FIELD_LABELS[k])
  if (changed.length > 0) {
    lines.push('', '**Updated fields:**')
    for (const key of changed) {
      const shown = key === 'persona' ? personaLabel(patch[key]) : patch[key]
      lines.push(`- **${PATCH_FIELD_LABELS[key]}:** ${shown}`)
    }
  }
  if (artifactMd) {
    lines.push('', '---', '', artifactMd.slice(0, 60000)) // GitHub's comment cap is 65536
  }
  lines.push(
    '',
    `_${PHASES[step.phase]} phase · attempt ${attempt}${isMock ? ' · mock agent' : ''} · [open in Horizon](${UI_URL}/${item.id.toLowerCase()}) · posted by Horizon_`,
  )
  return lines.join('\n')
}

// Every completed agent step is mirrored onto the GitHub issue — the issue
// thread is the human-readable record of what the bots did.
function postStepComment(item, stepIndex, attempt, summary, patch, isMock, artifactMd) {
  if (!item.repo || item.issue == null) return
  postIssueComment(item, stepCommentBody(item, stepIndex, attempt, summary, patch, isMock, artifactMd)).catch((err) => {
    addEvent(item.id, {
      who: 'Horizon',
      text: `could not post the step result to issue #${item.issue}: ${err.message}`,
      color: '#9C333E',
      initials: 'HZ',
    })
    notifyChange()
  })
}

// ---- automated review verdict (HZ-30) ----
// The reviewer is read-only (its farm tool allowlist has no Edit/Write/Bash)
// and structured JSON, validated HERE by the script — never trusted from the
// agent's prose, and never able to approve the human gate itself.

const VERDICT_VALUES = new Set(['pass', 'fail'])
const QA_BOOLEAN_FLAGS = ['regression_tests_run', 'new_code_unit_coverage', 'e2e_test_present']

// Exported for tests. A malformed/missing verdict is an infra/format
// problem, not a guardrail violation — the caller routes it to failFarmRun
// (pause for a human), which does NOT consume a review cycle.
export function validateVerdict(v) {
  if (!v || typeof v !== 'object') return false
  for (const key of ['code_review', 'qa_review']) {
    const section = v[key]
    if (!section || typeof section !== 'object' || !VERDICT_VALUES.has(section.verdict)) return false
  }
  return QA_BOOLEAN_FLAGS.every((flag) => typeof v.qa_review[flag] === 'boolean')
}

// Exported for tests. Compact, file/line-referenced feedback for whichever
// sub-pass(es) failed — this is what the implement step's next attempt reads
// as "Human feedback to address" (build_prompt in farm/step_agent.py).
export function formatReviewFeedback(verdict, cycle) {
  const lines = [`Automated review cycle ${cycle}/${REVIEW_CYCLE_CAP} failed — fix and re-implement.`]
  for (const [key, label] of [['code_review', 'Code review'], ['qa_review', 'QA review']]) {
    const section = verdict[key]
    if (section.verdict !== 'fail') continue
    lines.push('', `${label} findings:`)
    const findings = Array.isArray(section.findings) ? section.findings : []
    if (findings.length === 0) lines.push('- (no specific findings provided)')
    for (const f of findings.slice(0, 10)) {
      const loc = f?.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : 'general'
      lines.push(`- **${loc}** — ${f?.detail || f?.severity || 'issue flagged'}`)
    }
    if (key === 'qa_review') {
      const missing = QA_BOOLEAN_FLAGS.filter((flag) => section[flag] === false)
      if (missing.length > 0) lines.push(`- missing: ${missing.join(', ')}`)
    }
  }
  return lines.join('\n').slice(0, 2000)
}

// A markdown rendering so the mock path (no real agent artifact_md) still
// gives the human gate and the GitHub issue something to read.
function mockReviewArtifactMd(verdict) {
  const section = (label, s) =>
    `## ${label}\n**${s.verdict}**` + (s.verdict === 'fail' ? `\n- ${s.findings?.[0]?.detail || 'guardrail violation'}` : '')
  return [section('Code review', verdict.code_review), '', section('QA review', verdict.qa_review)].join('\n')
}

// Shared by completeFarmRun (real farm) and runMockStep (demo mode) so the
// pass/fail/cap routing is identical either way — verdict already validated
// by the caller. Closes the step_run row itself, then either advances the
// cursor (pass), rolls back to implement with feedback queued (fail, under
// cap), or force-advances to the human gate with the failing verdict still
// attached (fail, cap reached) — the loop counter that proves the cap is
// enforced lives in work_item.review_cycle_count, read back by tests.
function finalizeReviewStep(id, runId, text, artifactMd, verdict, patch, isMock) {
  const step = STEPS[REVIEW_STEP_INDEX]
  const agent = AGENTS[step.agent]
  const attempt = db.prepare('SELECT attempt FROM step_run WHERE id = ?').get(runId)?.attempt || 1
  db.prepare("UPDATE step_run SET status = 'done', output = ?, artifact = ?, ended_at = datetime('now') WHERE id = ?").run(
    text,
    artifactMd,
    runId,
  )

  const passed = verdict.code_review.verdict === 'pass' && verdict.qa_review.verdict === 'pass'
  if (passed) {
    db.prepare("UPDATE work_item SET cursor = cursor + 1, updated_at = datetime('now') WHERE id = ?").run(id)
    addEvent(id, { who: agent.label, text: `completed “${step.label}” — ${text.slice(0, 300)}`, color: agent.color, initials: agent.initials })
    postStepComment(getItem(id), REVIEW_STEP_INDEX, attempt, text, patch, isMock, artifactMd)
    notifyChange()
    kick(id)
    return
  }

  db.prepare("UPDATE work_item SET review_cycle_count = review_cycle_count + 1, updated_at = datetime('now') WHERE id = ?").run(id)
  const cycle = db.prepare('SELECT review_cycle_count FROM work_item WHERE id = ?').get(id).review_cycle_count

  if (cycle >= REVIEW_CYCLE_CAP) {
    db.prepare("UPDATE work_item SET cursor = cursor + 1, updated_at = datetime('now') WHERE id = ?").run(id)
    addEvent(id, {
      who: 'Horizon',
      text: `automated review cap (${REVIEW_CYCLE_CAP}) reached — forwarded to the human gate with the failing verdict attached`,
      color: '#9C333E',
      initials: 'HZ',
    })
    postStepComment(getItem(id), REVIEW_STEP_INDEX, attempt, text, patch, isMock, artifactMd)
    notifyChange()
    kick(id)
    return
  }

  db.prepare('INSERT INTO feedback (item_id, target, message) VALUES (?, ?, ?)').run(
    id,
    STEPS[IMPLEMENT_STEP_INDEX].agent,
    formatReviewFeedback(verdict, cycle),
  )
  db.prepare("UPDATE work_item SET cursor = ?, updated_at = datetime('now') WHERE id = ?").run(IMPLEMENT_STEP_INDEX, id)
  addEvent(id, {
    who: agent.label,
    text: `automated review failed (cycle ${cycle}/${REVIEW_CYCLE_CAP}) — sent back to “${STEPS[IMPLEMENT_STEP_INDEX].label}”`,
    color: '#9C333E',
    initials: agent.initials,
  })
  postStepComment(getItem(id), REVIEW_STEP_INDEX, attempt, text, patch, isMock, artifactMd)
  notifyChange()
  kick(id)
}

// ---- deploy verdict (HZ-22) ----
// The release itself is already published by the time this runs (JS side,
// dispatchToFarm) — this is the DevOps agent's deep-verification gate: did
// the deployed site actually render, not just answer 200. Reuses the same
// pass/fail enum as the automated review verdict.

// Exported for tests, same shape/rationale as validateVerdict: a malformed
// reply is an infra/format problem, not a real deploy failure, so the caller
// routes it to failFarmRun (pause for a human) rather than treating it as a
// failed deploy.
export function validateDeployVerdict(v) {
  return !!v && typeof v === 'object' && VERDICT_VALUES.has(v.verdict)
}

// A failing deploy verdict has no analogous "retry loop" the way code review
// does (redeploying isn't re-implementing) — it just pauses the item for a
// human to decide (rollback, redeploy, investigate), same as failFarmRun,
// but keeps the step_run's artifact/summary evidence instead of discarding it.
function finalizeDeployStep(id, runId, text, artifactMd, verdict, patch) {
  const step = STEPS[DEPLOY_STEP_INDEX]
  const agent = AGENTS[step.agent]
  const attempt = db.prepare('SELECT attempt FROM step_run WHERE id = ?').get(runId)?.attempt || 1
  db.prepare("UPDATE step_run SET status = 'done', output = ?, artifact = ?, ended_at = datetime('now') WHERE id = ?").run(
    text,
    artifactMd,
    runId,
  )

  if (verdict.verdict !== 'pass') {
    db.prepare("UPDATE work_item SET paused = 1, updated_at = datetime('now') WHERE id = ?").run(id)
    addEvent(id, {
      who: agent.label,
      text: `deploy verification failed — ${text.slice(0, 300)} — item paused; resume to redeploy`,
      color: '#9C333E',
      initials: agent.initials,
    })
    postStepComment(getItem(id), DEPLOY_STEP_INDEX, attempt, text, patch, false, artifactMd)
    notifyChange()
    return
  }

  db.prepare("UPDATE work_item SET cursor = cursor + 1, updated_at = datetime('now') WHERE id = ?").run(id)
  addEvent(id, { who: agent.label, text: `completed “${step.label}” — ${text.slice(0, 300)}`, color: agent.color, initials: agent.initials })
  postStepComment(getItem(id), DEPLOY_STEP_INDEX, attempt, text, patch, false, artifactMd)
  notifyChange()
  kick(id)
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
  // Persona patches are dropped (not failed) when invalid, and when the item
  // already carries one — a set value may be a human's gate-time choice, and
  // the farm must never clobber it. The run itself still completes.
  if ('persona' in cleanPatch && (!isPersona(cleanPatch.persona) || item.persona)) delete cleanPatch.persona
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

  const artifactMd =
    typeof artifacts?.artifact_md === 'string' ? artifacts.artifact_md.slice(0, WRITE_TIME_SANITY_CEILING_CHARS) : null

  if (run.step_index === REVIEW_STEP_INDEX) {
    if (!validateVerdict(artifacts?.verdict)) return failFarmRun(runId, 'malformed review verdict JSON')
    finalizeReviewStep(id, runId, text, artifactMd, artifacts.verdict, cleanPatch, false)
    return { ok: true }
  }

  if (run.step_index === DEPLOY_STEP_INDEX) {
    if (!validateDeployVerdict(artifacts?.verdict)) return failFarmRun(runId, 'malformed deploy verdict JSON')
    finalizeDeployStep(id, runId, text, artifactMd, artifacts.verdict, cleanPatch)
    return { ok: true }
  }

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
  let { summary, patch, verdict } = await behavior(item)

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

  if (stepIndex === REVIEW_STEP_INDEX) {
    // delete BEFORE finalizeReviewStep: it calls kick() internally, and
    // kick() no-ops while timers[id] (the busy marker for this run) is set.
    delete timers[id]
    finalizeReviewStep(id, runId, summary, mockReviewArtifactMd(verdict), verdict, patch, true)
    return
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
    const watchdogMs = run.step_index === IMPLEMENT_STEP_INDEX ? Math.max(FARM_STEP_TIMEOUT_MS, 50 * 60 * 1000) : FARM_STEP_TIMEOUT_MS
    timers[run.item_id] = setTimeout(() => failFarmRun(run.id, 'step timed out waiting for the farm'), watchdogMs)
  }
  return active.length
}

function closeAllOrphanedRuns() {
  db.prepare("UPDATE step_run SET status = 'superseded', ended_at = datetime('now') WHERE status = 'active'").run()
}
