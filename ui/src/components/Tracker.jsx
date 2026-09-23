import {
  AGENTS,
  PHASES,
  PHASE_ACCENT,
  PHASE_ACCENT_BG,
  STEPS,
  isClosed,
  phaseIdx,
  stepStatus,
  phaseStepIndexes,
  priorityColor,
} from '../domain/lifecycle'
import { PERSONAS, personaFor, personaId } from '../domain/personas'
import { itemStatus } from '../domain/status'
import { issueUrl, issueLabel, artifactUrl, outputUrl, runLogViewUrl } from '../api'
import StatusPill from './StatusPill'
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

const STEP_META_COLOR = { awaiting: '#9A6E00', blocked: '#9C333E', active: '#2E6CB2' }

function Step({ item, index, onApprove, onApproveWithComments, onReject, onResolveConflicts, onSetPersona }) {
  const st = STEPS[index]
  const status = stepStatus(item, index)
  const isGate = st.kind === 'gate'
  // The intake gate doubles as the human confirmation of the PM-proposed
  // specialist persona: approving with the select's value confirms it.
  const showsPersonaPicker = status === 'awaiting' && st.label === 'Approve & prioritize this work'
  const agent = isGate ? AGENTS.Human : AGENTS[st.agent]
  const agentLabel = isGate ? (st.gate === 'optional' ? 'Human gate · optional' : 'Human gate') : agent.label

  return (
    <div className="step">
      <div className="step__rail">
        <div className={`step__icon step__icon--${status}`}>{STEP_GLYPHS[status]}</div>
        <div className={`step__line${status === 'done' ? ' step__line--done' : ''}`} />
      </div>
      <div className="step__body">
        <div className={`step-card${['awaiting', 'active', 'blocked'].includes(status) ? ` step-card--${status}` : ''}`}>
          <div className="step-card__head">
            <div className="step-card__label">{st.label}</div>
            <span className="step-card__agent" style={{ color: agent.color }}>
              <span className="step-card__agent-dot" style={{ background: agent.color }} />
              {agentLabel}
            </span>
          </div>
          <div className="step-card__meta" style={{ color: STEP_META_COLOR[status] || '#8C8C8E' }}>
            {STEP_META[status](isGate, st.gate)}
            {status === 'active' && item.activeRun?.step_index === index && (
              <span>
                {' · '}
                {elapsedMinutes(item.activeRun.started_at) < 1
                  ? 'just started'
                  : `${elapsedMinutes(item.activeRun.started_at)} min`}
                {item.activeRun.attempt > 1 && ` · attempt ${item.activeRun.attempt}`}
              </span>
            )}
            {status === 'done' && item.stepOutputs?.[index]?.attempt > 1 && !item.stepOutputs?.[index]?.artifact && (
              <span className="step-card__attempt"> · attempt {item.stepOutputs[index].attempt}</span>
            )}
            {status === 'done' && !isGate && !item.stepOutputs?.[index] && (
              <span> · no output recorded (step predates this item's run or was skipped)</span>
            )}
          </div>
          {status === 'done' && !isGate && item.stepOutputs?.[index]?.output && (
            <a
              className="step-card__output-link"
              href={outputUrl(item.id, index)}
              target="_blank"
              rel="noopener noreferrer"
            >
              See agent output ↗
            </a>
          )}
          {status === 'done' && !isGate && item.stepOutputs?.[index]?.artifact && (
            <a
              className="step-card__artifact-link"
              href={artifactUrl(item.id, index)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {item.stepOutputs[index].attemptCount > 1
                ? `attempt ${item.stepOutputs[index].attempt} of ${item.stepOutputs[index].attemptCount} ↗`
                : 'View full artifact ↗'}
            </a>
          )}
          {showsPersonaPicker && (
            <div className="step-card__persona">
              <label className="step-card__persona-label" htmlFor={`persona-${item.id}`}>
                Specialist persona
              </label>
              <select
                id={`persona-${item.id}`}
                className="step-card__persona-select"
                value={personaId(item)}
                onChange={(e) => onSetPersona(item.id, e.target.value)}
              >
                {Object.entries(PERSONAS).map(([id, p]) => (
                  <option key={id} value={id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {status === 'awaiting' && st.label === 'Accept the code' && item.pr != null && item.pr_mergeable === false && (
            <div className="step-card__conflict">
              PR #{item.pr} has merge conflicts with main — approving would fail.
              <button className="btn-gate-reject" onClick={() => onResolveConflicts(item.id, item.pr)}>
                Send back to resolve conflicts
              </button>
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
              <button className="btn-gate-approve" onClick={() => onApprove(item.id, st.label)}>
                Approve
              </button>
              <button className="btn-gate-feedback" onClick={() => onApproveWithComments(item.id, st.label)}>
                Approve with comments
              </button>
              <button className="btn-gate-reject" onClick={() => onReject(item.id, st.label)}>
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
  const events = (item.events || []).map((e) => ({ ...e, time: relTime(e.created_at) }))
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
        color: a.color,
        initials: s.kind === 'gate' ? '✓' : a.initials,
      }
    })
}

export default function Tracker({ item, onBack, onApprove, onApproveWithComments, onReject, onResolveConflicts, onTogglePause, onRestartPhase, onSetPersona }) {
  const status = itemStatus(item, true)
  const activity = buildActivity(item)

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
              <span className="tracker__priority" style={{ color: priorityColor(item.priority) }}>
                <span className="tracker__priority-dot" style={{ background: priorityColor(item.priority) }} />
                {item.priority} priority
              </span>
              <span className="tracker__priority" style={{ color: personaFor(item).color }}>
                <span className="tracker__priority-dot" style={{ background: personaFor(item).color }} />
                {personaFor(item).label}
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
            <div className="tracker__desc">{item.desc}</div>
          </div>
          <StatusPill status={status} className="tracker__status" />
        </div>
        <div className="tracker__actions">
          <button className="btn-outline" onClick={() => onTogglePause(item.id)}>
            {item.paused ? 'Resume work' : 'Pause work'}
          </button>
        </div>
        <div className="tracker__tiles">
          <div className="tile">
            <div className="tile__label">Success metric</div>
            <div className="tile__value">{item.metric}</div>
          </div>
          <div className="tile">
            <div className="tile__label">Guardrails</div>
            <div className="tile__value">{item.guardrails}</div>
          </div>
        </div>
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
            const phaseStatusColor = allDone ? '#0E6E74' : anyActive ? '#2E6CB2' : '#8C8C8E'
            const restartable = !isClosed(item) && phaseIdx(item) >= p
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
                    index={i}
                    onApprove={onApprove}
                    onApproveWithComments={onApproveWithComments}
                    onReject={onReject}
                    onResolveConflicts={onResolveConflicts}
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
