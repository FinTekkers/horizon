import { useEffect, useRef, useState } from 'react'
import {
  PHASES,
  STEPS,
  IMPLEMENT_STEP_INDEX,
  ACCEPT_GATE_INDEX,
  isClosed,
  isAbandoned,
  phaseIdx,
  stepStatus,
  phaseStepIndexes,
} from '../../../domain/js/lifecycle.js'
import { AGENTS } from '../domain/agentTokens'
import { PHASE_ACCENT, PHASE_ACCENT_BG, priorityColor } from '../domain/lifecycle'
import { PERSONAS, PERSONA_AGENT_ROLES, PRIMARY_PERSONA_AGENT, personaFor, personaId } from '../domain/personas'
import { itemStatus } from '../domain/status'
import { pauseReason } from '../domain/pauseReason'
import { gateActionOf } from '../domain/gateAction'
import { deployQueueLabel } from '../domain/deployQueue'
import { resolveEventColor } from '../domain/eventColors'
import { issueUrl, issueLabel, artifactUrl, outputUrl, runLogViewUrl, subscribeStepOutputs } from '../api'
import StatusPill from './StatusPill'
import DependencyBadge from './DependencyBadge'
import Markdown from './Markdown'
import GateActionStatus from './GateActionStatus'
import ProjectBadge from './ProjectBadge'
import { BackIcon, LinkIcon, RestartIcon, PrIcon } from './icons'

const STEP_GLYPHS = { done: '✓', active: '•', awaiting: '!', pending: '', blocked: '✕' }

function elapsedMinutes(startedAt) {
  if (!startedAt) return null
  const t = Date.parse(startedAt.includes('T') ? startedAt : startedAt.replace(' ', 'T') + 'Z')
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((Date.now() - t) / 60_000))
}

const STEP_META = {
  done: (isGate) => (isGate ? 'Approved by you' : 'Completed'),
  active: () => 'In progress…',
  awaiting: (isGate, gate) => (isGate && gate === 'optional' ? 'Optional gate · awaiting you' : 'Awaiting your approval'),
  pending: () => 'Queued',
  blocked: () => 'Changes requested',
}

const STEP_META_COLOR = { awaiting: 'var(--warning-ink)', blocked: 'var(--danger-ink)', active: 'var(--primary-ink)' }

// HZ-185: why a forward to Accept the code didn't go through, keyed by the
// route's error code. Anything else falls back to a generic line.
const FORWARD_ERRORS = {
  review_not_rejected: 'The latest review is no longer a rejection — nothing to forward.',
  not_in_execute: 'This item is no longer in Execute.',
  forward_in_progress: 'A forward is already in progress.',
  branch_moved: 'The PR moved past the reviewed commit — implement restarted with the findings instead.',
  branch_unverified: 'Could not confirm the PR is still at the reviewed commit — implement restarted with the findings instead.',
}

// HZ-185: on an item the latest automated review just rejected, sends it to
// Accept the code with that verdict attached instead of another implement
// cycle. The ref is the guard (two clicks in one tick both read the same
// stale state); `busy` only renders it. Disabled until the request settles,
// and while a gate action runs (HZ-216).
function ForwardToAcceptButton({ item, onForwardToAccept, disabled }) {
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const forward = () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    new Promise((resolve) => resolve(onForwardToAccept(item.id)))
      .catch(() => null)
      .then((result) => {
        inFlight.current = false
        setBusy(false)
        if (result?.ok !== true) setError(FORWARD_ERRORS[result?.error] || 'The forward did not go through — try again.')
      })
  }
  return (
    <div className="step-card__conflict">
      Automated review rejected this. Forward it to “{STEPS[ACCEPT_GATE_INDEX].label}” with the findings attached?
      <button className="btn-gate-reject" disabled={busy || disabled} aria-busy={busy || undefined} onClick={forward}>
        {busy ? 'Forwarding…' : `Forward to ${STEPS[ACCEPT_GATE_INDEX].label}`}
      </button>
      {error && <span role="alert">{error}</span>}
    </div>
  )
}

// HZ-185: on the Accept gate, the failing review a forward carried (the review
// cap's or a human's) — that run's findings, not whatever review is newest.
function ForwardedReview({ forwarded }) {
  return (
    <div className="step-card__forwarded">
      <div className="step-card__forwarded-title">
        Forwarded by {forwarded.by || 'Horizon'} with the failing review (run #{forwarded.runId}) attached
      </div>
      {forwarded.artifact ? (
        <Markdown className="step-card__forwarded-body" text={forwarded.artifact} />
      ) : (
        <div>The review recorded no findings text.</div>
      )}
    </div>
  )
}

function Step({ item, stepOutputs, outputsSettled, index, onApprove, onApproveWithComments, onReject, onResolveConflicts, resolving, gateBusy, onForwardToAccept, onSetPersona }) {
  const st = STEPS[index]
  const status = stepStatus(item, index)
  const isGate = st.kind === 'gate'
  // Dispatched but still sitting in the farm's queue, not yet claimed by an
  // agent (HZ-54) — distinct from "In progress…", which now means the farm
  // itself reports the step as running.
  const queued = status === 'active' && item.activeRun?.step_index === index && item.activeRun?.state === 'queued'
  // The intake gate doubles as the human confirmation of the PM-proposed
  // specialist persona: approving with the select's value confirms it.
  const showsPersonaPicker = status === 'awaiting' && st.label === 'Approve & prioritize this work'
  const agent = isGate ? AGENTS.Human : AGENTS[st.agent]
  const agentLabel = isGate ? (st.gate === 'optional' ? 'Human gate · optional' : 'Human gate') : agent.label
  const gateAction = index === ACCEPT_GATE_INDEX ? gateActionOf(item) : null
  const output = stepOutputs?.[index]

  return (
    <div className="step">
      <div className="step__rail">
        <div className={`step__icon step__icon--${status}${queued ? ' step__icon--queued' : ''}`}>
          {queued ? '⋯' : STEP_GLYPHS[status]}
        </div>
        <div className={`step__line${status === 'done' ? ' step__line--done' : ''}`} />
      </div>
      <div className="step__body">
        <div
          className={`step-card${['awaiting', 'active', 'blocked'].includes(status) ? ` step-card--${status}` : ''}${queued ? ' step-card--queued' : ''}`}
        >
          <div className="step-card__head">
            <div className="step-card__label">{st.label}</div>
            <span className="step-card__agent" style={{ color: agent.color }}>
              <span className="step-card__agent-dot" style={{ background: agent.color }} />
              {agentLabel}
            </span>
          </div>
          {/* HZ-54's queued state kept, but using main's theme token rather
              than the hardcoded hex it originally shipped — dark mode (HZ-25)
              moved every colour in this file behind a CSS variable. */}
          <div className="step-card__meta" style={{ color: queued ? 'var(--muted)' : STEP_META_COLOR[status] || 'var(--muted)' }}>
            {queued ? 'Queued' : STEP_META[status](isGate, st.gate)}
            {status === 'active' && item.activeRun?.step_index === index && (
              <span>
                {' · '}
                {elapsedMinutes(item.activeRun.started_at) < 1
                  ? 'just started'
                  : `${elapsedMinutes(item.activeRun.started_at)} min`}
                {item.activeRun.attempt > 1 && ` · attempt ${item.activeRun.attempt}`}
                {queued && item.activeRun.reason && ` · ${item.activeRun.reason}`}
              </span>
            )}
            {index === item.cursor && deployQueueLabel(item) && (
              <span className="step-card__deploy-queue"> · {deployQueueLabel(item)}</span>
            )}
            {status === 'done' && output?.attempt > 1 && !output?.artifact && (
              <span className="step-card__attempt"> · attempt {output.attempt}</span>
            )}
            {/* Not while the outputs are loading: a step that just finished
                would read "no output recorded" for a moment. */}
            {status === 'done' && !isGate && outputsSettled && !output && (
              <span> · no output recorded (step predates this item's run or was skipped)</span>
            )}
          </div>
          {status === 'done' && !isGate && output?.output && (
            <a
              className="step-card__output-link"
              href={outputUrl(item.id, index)}
              target="_blank"
              rel="noopener noreferrer"
            >
              See agent output ↗
            </a>
          )}
          {status === 'done' && !isGate && output?.artifact && (
            <a
              className="step-card__artifact-link"
              href={artifactUrl(item.id, index)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {output.attemptCount > 1
                ? `attempt ${output.attempt} of ${output.attemptCount} ↗`
                : 'View full artifact ↗'}
            </a>
          )}
          {/* One control per persona agent (HZ-125): personas are agent-scoped,
              so the human confirms the Eng specialization the PM proposed and
              can set the QA, Architect and PM ones in the same place. */}
          {showsPersonaPicker &&
            Object.keys(PERSONAS).map((agent) => (
              <div className="step-card__persona" key={agent}>
                <label className="step-card__persona-label" htmlFor={`persona-${agent}-${item.id}`}>
                  {AGENTS[PERSONA_AGENT_ROLES[agent]].label} persona
                </label>
                <select
                  id={`persona-${agent}-${item.id}`}
                  className="step-card__persona-select"
                  value={personaId(item, agent)}
                  onChange={(e) => onSetPersona(item.id, agent, e.target.value)}
                >
                  {Object.entries(PERSONAS[agent])
                    .filter(([, p]) => !p.testOnly)
                    .map(([id, p]) => (
                      <option key={id} value={id}>
                        {p.label}
                      </option>
                    ))}
                </select>
              </div>
            ))}
          {status === 'awaiting' && index === ACCEPT_GATE_INDEX && item.forwardedReview && (
            <ForwardedReview forwarded={item.forwardedReview} />
          )}
          {index === IMPLEMENT_STEP_INDEX && item.reviewRejected && onForwardToAccept && !isAbandoned(item) && (
            <ForwardToAcceptButton item={item} onForwardToAccept={onForwardToAccept} disabled={gateBusy} />
          )}
          {gateAction && (status === 'awaiting' || gateAction.state === 'merged') && (
            <GateActionStatus
              action={gateAction}
              pr={item.pr}
              onRetry={status === 'awaiting' ? () => onApprove(item.id, st.label) : undefined}
              retryDisabled={gateBusy}
            />
          )}
          {status === 'awaiting' && st.label === 'Accept the code' && item.pr != null && item.pr_mergeable === false && (
            <div className="step-card__conflict">
              PR #{item.pr} has merge conflicts with main — approving would fail.
              {/* HZ-188: disabled while a run is in progress (here or in any tab —
                  `resolving` comes from the server's conflictRun), so it can't be
                  started twice; View progress reopens the dialog. */}
              <button
                className="btn-gate-reject"
                disabled={resolving || gateBusy}
                aria-busy={resolving || undefined}
                onClick={() => onResolveConflicts(item.id, item.pr)}
              >
                {resolving ? 'Resolving conflicts…' : 'Resolve conflicts…'}
              </button>
              {resolving && (
                <button className="btn-gate-feedback" onClick={() => onResolveConflicts(item.id, item.pr)}>
                  View progress
                </button>
              )}
            </div>
          )}
          {status === 'awaiting' && (
            <div className="step-card__actions">
              {item.pr != null && st.label === 'Accept the code' && (
                <a className="btn-pr-review" href={item.pr_url} target="_blank" rel="noopener noreferrer">
                  <PrIcon size={13} />
                  Review PR #{item.pr} ↗
                </a>
              )}
              {/* HZ-216: disabled while a gate action runs, whoever started it.
                  The server's 409 stays the real protection. */}
              <button
                className="btn-gate-approve"
                disabled={gateBusy}
                aria-busy={gateBusy || undefined}
                onClick={() => onApprove(item.id, st.label)}
              >
                Approve
              </button>
              <button
                className="btn-gate-feedback"
                disabled={gateBusy}
                aria-busy={gateBusy || undefined}
                onClick={() => onApproveWithComments(item.id, st.label)}
              >
                Approve with comments
              </button>
              <button
                className="btn-gate-reject"
                disabled={gateBusy}
                aria-busy={gateBusy || undefined}
                onClick={() => onReject(item.id, st.label)}
              >
                Send back with feedback
              </button>
            </div>
          )}
          {status === 'active' && item.activeRun?.step_index === index && item.activeRun.id != null && (
            <a
              className="step-card__output-link"
              href={runLogViewUrl(item.activeRun.id)}
              target="_blank"
              rel="noopener noreferrer"
            >
              See agent output ↗
            </a>
          )}
          {status === 'active' && (
            <div className="step-card__actions">
              <button className="btn-step-reject" onClick={() => onReject(item.id, st.label)}>
                Request changes
              </button>
            </div>
          )}
          {status === 'blocked' && (
            <div className="step-card__actions">
              <button className="btn-gate-reject" onClick={() => onReject(item.id, st.label)}>
                Send back for rework
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// HZ-94: explains a paused item beyond the generic "Paused" flag — reads the
// classified failure reason back out of the pause event the orchestrator
// already writes (server/src/orchestrator.js's failFarmRun), never inventing
// one of its own. A manual human pause has nothing to explain and renders
// nothing here — the existing Resume control already covers it.
function PauseBanner({ item }) {
  const reason = pauseReason(item)
  if (!reason || reason.category === 'manual') return null

  const attemptsText =
    reason.attemptsUsed > 0
      ? `Auto-retried ${reason.attemptsUsed} time${reason.attemptsUsed === 1 ? '' : 's'}${reason.exhausted ? ' — retry budget exhausted' : ''}`
      : 'Not auto-retried'

  return (
    <div className="pause-banner">
      <div className="pause-banner__title">{reason.label || 'Paused'}</div>
      <div className="pause-banner__detail">
        {reason.detail && <span>{reason.detail} </span>}
        {reason.cause || 'No failure details were recorded for this pause — check the activity feed below.'}
      </div>
      <div className="pause-banner__meta">{attemptsText} · Resume to retry</div>
    </div>
  )
}

// Server timestamps are sqlite UTC "YYYY-MM-DD HH:MM:SS".
function relTime(createdAt) {
  if (!createdAt) return 'just now'
  const t = Date.parse(createdAt.includes('T') ? createdAt : createdAt.replace(' ', 'T') + 'Z')
  if (Number.isNaN(t)) return 'just now'
  const mins = Math.floor((Date.now() - t) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

function buildActivity(item) {
  // Real events (orchestrator + human actions + GitHub) when we have them…
  const events = (item.events || []).map((e) => ({
    ...e,
    time: relTime(e.created_at),
    color: resolveEventColor(e.color),
  }))
  if (events.length > 0) return events.slice(0, 12)

  // …otherwise derive placeholders from completed steps (demo/mock items).
  const times = ['just now', '8 min ago', '40 min ago', '2 hours ago', '5 hours ago', 'yesterday', '2 days ago']
  const done = STEPS.map((s, i) => ({ s, i })).filter(({ i }) => stepStatus(item, i) === 'done')
  return done
    .reverse()
    .slice(0, 6)
    .map(({ s }, k) => {
      const a = s.kind === 'gate' ? AGENTS.Human : AGENTS[s.agent]
      return {
        who: s.kind === 'gate' ? 'You' : a.label,
        text: s.kind === 'gate' ? `approved: ${s.label.toLowerCase()}` : `completed ${s.label.toLowerCase()}`,
        time: times[Math.min(k, times.length - 1)],
        color: a.avatarBg,
        initials: s.kind === 'gate' ? '✓' : a.initials,
      }
    })
}

// HZ-318: the board feed leaves stepOutputs off, so the open item streams its
// own: opened on mount and when the item changes, closed on leave. The server
// sends the whole map again whenever it changes, so a step finishing while the
// item is open shows its output. An item that still carries the field (a
// server from before HZ-318) is used as it is.
//
// { stepOutputs, settled }: settled is false until this item's first frame, so
// no step reads "no output recorded" while they load. A frame for an item no
// longer open is dropped.
function useStepOutputs(item) {
  const [loaded, setLoaded] = useState({ id: null, stepOutputs: null })
  const carried = item.stepOutputs
  const hasCarried = carried != null
  const { id } = item
  useEffect(() => {
    if (hasCarried) return undefined
    let open = true
    const close = subscribeStepOutputs(id, (stepOutputs) => {
      if (open) setLoaded({ id, stepOutputs })
    })
    return () => {
      open = false
      close()
    }
  }, [id, hasCarried])
  if (hasCarried) return { stepOutputs: carried, settled: true }
  const mine = loaded.id === id
  return { stepOutputs: mine ? loaded.stepOutputs : null, settled: mine }
}

export default function Tracker({ item, projects, onBack, onApprove, onApproveWithComments, onReject, onResolveConflicts, resolving, gateBusy, onForwardToAccept, onTogglePause, onRestartPhase, onSetPersona, onAbandon, onRemoveDependency }) {
  const status = itemStatus(item, true)
  const activity = buildActivity(item)
  const closed = isClosed(item)
  const abandoned = isAbandoned(item)
  const { stepOutputs, settled: outputsSettled } = useStepOutputs(item)

  return (
    <div className="tracker">
      <button className="tracker__back" onClick={onBack}>
        <BackIcon />
        Back to board
      </button>

      <div className="panel tracker__header">
        <div className="tracker__header-row">
          <div className="tracker__header-main">
            <div className="tracker__meta">
              <span className="tracker__id">{item.id}</span>
              <ProjectBadge projectId={item.project_id} projects={projects} />
              <span className="tracker__priority" style={{ color: priorityColor(item.priority) }}>
                <span className="tracker__priority-dot" style={{ background: priorityColor(item.priority) }} />
                {item.priority} priority
              </span>
              {/* The Eng persona: the item's primary specialization, the one
                  that decides who writes the code. Every agent's persona is
                  visible in the gate's picker. */}
              <span className="tracker__priority" style={{ color: personaFor(item, PRIMARY_PERSONA_AGENT).color }}>
                <span
                  className="tracker__priority-dot"
                  style={{ background: personaFor(item, PRIMARY_PERSONA_AGENT).color }}
                />
                {personaFor(item, PRIMARY_PERSONA_AGENT).label}
              </span>
              {item.issue != null && (
                <a className="tracker__issue" href={issueUrl(item)} target="_blank" rel="noopener noreferrer">
                  <LinkIcon size={13} />
                  Issue {issueLabel(item)}
                </a>
              )}
              {item.pr != null && (
                <a className="tracker__issue" href={item.pr_url} target="_blank" rel="noopener noreferrer">
                  <PrIcon size={13} />
                  PR #{item.pr}
                </a>
              )}
              {item.release_tag && item.release_url && (
                <a className="tracker__issue" href={item.release_url} target="_blank" rel="noopener noreferrer">
                  <LinkIcon size={13} />
                  {item.release_tag}
                </a>
              )}
            </div>
            <div className="tracker__title">{item.title}</div>
            {/* HZ-153: issue bodies are markdown — Markdown renders them as
                React elements, never as HTML. Same for the two tiles below. */}
            <Markdown className="tracker__desc" text={item.desc} />
          </div>
          <StatusPill status={status} className="tracker__status" />
        </div>
        {!abandoned && (
          <div className="tracker__actions">
            <button className="btn-outline" onClick={() => onTogglePause(item.id)}>
              {item.paused ? 'Resume work' : 'Pause work'}
            </button>
            {!closed && (
              <button className="btn-outline" style={{ color: '#5C1F2B' }} onClick={() => onAbandon(item.id)}>
                Abandon
              </button>
            )}
          </div>
        )}
        {!abandoned && item.paused && <PauseBanner item={item} />}
        {abandoned && item.abandoned_reason && (
          <div className="tracker__actions">
            <div className="tile__value" style={{ color: '#5C1F2B' }}>
              Abandoned by {item.abandoned_by || 'a human'}: {item.abandoned_reason}
            </div>
          </div>
        )}
        <div className="tracker__tiles">
          <div className="tile">
            <div className="tile__label">Success metric</div>
            <Markdown className="tile__value md-body--tile" text={item.metric} />
          </div>
          <div className="tile">
            <div className="tile__label">Guardrails</div>
            <Markdown className="tile__value md-body--tile" text={item.guardrails} />
          </div>
        </div>
        <DependencyBadge key={item.id} item={item} onRemove={onRemoveDependency} />
      </div>

      <div className="tracker__body">
        <div className="panel tracker__stepper">
          <div className="panel__title">Lifecycle</div>
          <div className="panel__subtitle">Five phases · agent-driven steps with human gates</div>
          {PHASES.map((name, p) => {
            const idxs = phaseStepIndexes(p)
            const allDone = idxs.every((i) => stepStatus(item, i) === 'done')
            const anyActive = idxs.some((i) => ['active', 'awaiting'].includes(stepStatus(item, i)))
            const phaseStatusLabel = allDone ? 'Complete' : anyActive ? 'In progress' : 'Upcoming'
            const phaseStatusColor = allDone ? 'var(--success-ink)' : anyActive ? 'var(--primary-ink)' : 'var(--muted)'
            // An abandoned item is terminal too — it must not offer a restart.
            const restartable = !isClosed(item) && !abandoned && phaseIdx(item) >= p
            return (
              <div key={name} className="phase">
                <div className="phase__head">
                  <span className="phase__num" style={{ background: PHASE_ACCENT_BG[p], color: PHASE_ACCENT[p] }}>
                    {p + 1}
                  </span>
                  <span className="phase__name">{name}</span>
                  <span className="phase__status" style={{ color: phaseStatusColor }}>
                    {phaseStatusLabel}
                  </span>
                  <span className="phase__spacer" />
                  {restartable && (
                    <button className="phase__restart" onClick={() => onRestartPhase(item.id, p)}>
                      <RestartIcon />
                      Restart phase
                    </button>
                  )}
                </div>
                {idxs.map((i) => (
                  <Step
                    key={i}
                    item={item}
                    stepOutputs={stepOutputs}
                    outputsSettled={outputsSettled}
                    index={i}
                    onApprove={onApprove}
                    onApproveWithComments={onApproveWithComments}
                    onReject={onReject}
                    onResolveConflicts={onResolveConflicts}
                    resolving={resolving}
                    gateBusy={gateBusy}
                    onForwardToAccept={onForwardToAccept}
                    onSetPersona={onSetPersona}
                  />
                ))}
              </div>
            )
          })}
        </div>

        <div className="panel tracker__activity">
          <div className="panel__title" style={{ marginBottom: 20 }}>
            Activity
          </div>
          {activity.map((ac, i) => (
            <div key={i} className="activity-row">
              <span className="activity-row__avatar" style={{ background: ac.color }}>
                {ac.initials}
              </span>
              <div style={{ flex: 1 }}>
                <div className="activity-row__text">
                  <strong>{ac.who}</strong> {ac.text}
                </div>
                <div className="activity-row__time">{ac.time}</div>
              </div>
            </div>
          ))}
          {activity.length === 0 && (
            <div className="activity-empty">No activity yet — this work is still being planned.</div>
          )}
        </div>
      </div>
    </div>
  )
}
