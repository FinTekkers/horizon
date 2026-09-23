import {
  PHASES,
  PHASE_ACCENT,
  PHASE_ACCENT_BG,
  isClosed,
  curStep,
  phaseIdx,
  awaitingGate,
  priorityColor,
} from '../domain/lifecycle'
import { personaFor } from '../domain/personas'
import { itemStatus } from '../domain/status'
import { issueUrl, issueLabel } from '../api'
import StatusPill from './StatusPill'
import { LinkIcon, LockIcon, PrIcon } from './icons'

function progressSegs(item) {
  const closed = isClosed(item)
  const p = phaseIdx(item)
  const awaiting = awaitingGate(item)
  const rejected = item.rejected && !closed
  return [0, 1, 2, 3, 4].map((i) => {
    if (closed || i < p) return '#2E6CB2'
    if (i === p) return awaiting ? '#DFA200' : rejected ? '#9C333E' : '#2E6CB2'
    return '#E4DEEE'
  })
}

function BoardCard({ item, onOpen, onApprove, onReject, onTogglePause }) {
  const closed = isClosed(item)
  const rejected = item.rejected && !closed
  const paused = !!item.paused && !closed && !rejected
  const awaiting = awaitingGate(item)
  const cur = curStep(item)
  const isActiveAgent = !closed && !awaiting && !rejected && !paused && cur && cur.kind === 'agent'
  const rejectTarget = awaiting && cur ? cur.label : cur ? cur.label : 'this step'

  return (
    <div className={`card${awaiting ? ' card--awaiting' : ''}`} onClick={() => onOpen(item.id)}>
      <div className="card__meta">
        <span className="card__dot" style={{ background: priorityColor(item.priority) }} />
        <span className="card__id">{item.id}</span>
        {item.repo && <span className="card__repo">{item.repo.split('/')[1]}</span>}
        {item.issue != null && (
          <a
            className="card__issue"
            href={issueUrl(item)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            <LinkIcon />
            {issueLabel(item)}
          </a>
        )}
        {item.pr != null && (
          <a
            className="card__issue"
            href={item.pr_url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            <PrIcon />
            PR #{item.pr}
          </a>
        )}
        <span style={{ flex: 1 }} />
        <span className="card__priority">{item.priority}</span>
      </div>
      <div className="card__title">{item.title}</div>
      <div className="card__segs">
        {progressSegs(item).map((color, i) => (
          <div key={i} className="card__seg" style={{ background: color }} />
        ))}
      </div>
      <div className="card__status-row">
        <span className="card__phase">{PHASES[phaseIdx(item)]}</span>
        <span className="card__persona" style={{ color: personaFor(item).color }} title="Specialist persona">
          {personaFor(item).label}
        </span>
        <StatusPill status={itemStatus(item)} />
      </div>

      {awaiting && (
        <div className="card__gate">
          <div className="card__gate-label">
            <LockIcon size={13} strokeWidth={2.4} />
            {cur.label}
          </div>
          <div className="card__gate-actions">
            <button
              className="btn-approve"
              onClick={(e) => {
                e.stopPropagation()
                onApprove(item.id, cur.label)
              }}
            >
              Approve
            </button>
            <button
              className="btn-reject"
              onClick={(e) => {
                e.stopPropagation()
                onReject(item.id, rejectTarget)
              }}
            >
              Send back
            </button>
          </div>
        </div>
      )}

      {isActiveAgent && (
        <button
          className="btn-pause"
          onClick={(e) => {
            e.stopPropagation()
            onTogglePause(item.id)
          }}
        >
          Pause work
        </button>
      )}

      {paused && (
        <button
          className="btn-resume"
          onClick={(e) => {
            e.stopPropagation()
            onTogglePause(item.id)
          }}
        >
          Resume work
        </button>
      )}
    </div>
  )
}

export default function Board({ items, onOpen, onApprove, onReject, onTogglePause, onNewItem }) {
  return (
    <div className="board">
      <div className="board__head">
        <div className="board__title">Work in flight</div>
        <div className="board__meta">{items.length} items across the lifecycle</div>
        <span style={{ flex: 1 }} />
        <button className="btn-new" onClick={onNewItem}>
          + New work item
        </button>
      </div>
      <div className="board__cols">
        {PHASES.map((name, p) => {
          const colItems = items.filter((it) => phaseIdx(it) === p)
          return (
            <div key={name} className="col">
              <div className="col__head">
                <span
                  className="col__num"
                  style={{ background: PHASE_ACCENT_BG[p], color: PHASE_ACCENT[p] }}
                >
                  {p + 1}
                </span>
                <span className="col__name">{name}</span>
                <span className="col__count">{colItems.length}</span>
              </div>
              <div className="col__cards">
                {colItems.map((item) => (
                  <BoardCard
                    key={item.id}
                    item={item}
                    onOpen={onOpen}
                    onApprove={onApprove}
                    onReject={onReject}
                    onTogglePause={onTogglePause}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
