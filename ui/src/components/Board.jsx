import { useSyncExternalStore } from 'react'
import {
  PHASES,
  PHASE_ACCENT,
  PHASE_ACCENT_BG,
  isClosed,
  isAbandoned,
  curStep,
  phaseIdx,
  awaitingGate,
  priorityColor,
} from '../domain/lifecycle'
import { FILTERS, visibleItems, hiddenCounts, matchCounts } from '../domain/filters'
import { personaFor } from '../domain/personas'
import { itemStatus } from '../domain/status'
import { issueUrl, issueLabel } from '../api'
import * as boardFilters from '../boardFilters'
import StatusPill from './StatusPill'
import { LinkIcon, LockIcon, PrIcon } from './icons'

function progressSegs(item) {
  const closed = isClosed(item)
  const abandoned = isAbandoned(item)
  const p = phaseIdx(item)
  const awaiting = awaitingGate(item)
  const rejected = item.rejected && !closed && !abandoned
  return [0, 1, 2, 3, 4].map((i) => {
    // Abandoned kept from this branch, but through main's theme tokens —
    // dark mode (HZ-25) moved every colour here behind a CSS variable.
    if (abandoned) return i <= p ? 'var(--deep)' : 'var(--border-strong)'
    if (closed || i < p) return 'var(--primary)'
    if (i === p) return awaiting ? 'var(--warning)' : rejected ? 'var(--danger)' : 'var(--primary)'
    return 'var(--border-strong)'
  })
}

function BoardCard({ item, onOpen, onApprove, onReject, onTogglePause }) {
  const closed = isClosed(item)
  const abandoned = isAbandoned(item)
  const rejected = item.rejected && !closed && !abandoned
  const paused = !!item.paused && !closed && !abandoned && !rejected
  const awaiting = awaitingGate(item)
  const cur = curStep(item)
  const isActiveAgent = !closed && !abandoned && !awaiting && !rejected && !paused && cur && cur.kind === 'agent'
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
  const activeFilterKeys = useSyncExternalStore(boardFilters.subscribe, boardFilters.getActiveFilters)
  const now = new Date()
  // Filtering is a view concern only — it narrows what's rendered here, and
  // never touches an item or what the farm dispatches (HZ-80).
  const shown = visibleItems(items, activeFilterKeys, now)
  const hidden = hiddenCounts(items, activeFilterKeys, now)
  const matches = matchCounts(items, now)
  const totalHidden = Object.values(hidden).reduce((sum, n) => sum + n, 0)
  const hiddenSummary = FILTERS.filter((f) => hidden[f.key] > 0)
    .map((f) => `${hidden[f.key]} ${f.noun}`)
    .join(', ')
  // Abandoned items that are still shown (their filter toggled off) don't
  // count as active work: they've stopped being dispatched.
  const activeCount = shown.filter((it) => !isAbandoned(it)).length

  return (
    <div className="board">
      <div className="board__head">
        <div className="board__title">Work in flight</div>
        <div className="board__meta">{activeCount} items across the lifecycle</div>
        {totalHidden > 0 && shown.length > 0 && (
          <div className="board__hidden-note">
            Hiding {hiddenSummary}
            <button className="board__show-all" onClick={() => boardFilters.setActiveFilters([])}>
              Show all
            </button>
          </div>
        )}
        <span style={{ flex: 1 }} />
        <div className="board__filters">
          {FILTERS.map((f) => {
            const on = activeFilterKeys.includes(f.key)
            return (
              <button
                key={f.key}
                className={`board__filter-chip${on ? ' board__filter-chip--active' : ''}`}
                onClick={() => boardFilters.toggleFilter(f.key)}
                title={on ? `Hiding ${matches[f.key]} ${f.noun} item(s) — click to show` : `Showing ${matches[f.key]} ${f.noun} item(s) — click to hide`}
              >
                {f.label} ({matches[f.key]})
              </button>
            )
          })}
        </div>
        <button className="btn-new" onClick={onNewItem}>
          + New work item
        </button>
      </div>

      {items.length === 0 && <div className="board__empty">No work items yet.</div>}

      {items.length > 0 && shown.length === 0 && (
        <div className="board__empty">
          All {items.length} items are hidden by the active filters.{' '}
          <button className="board__show-all" onClick={() => boardFilters.setActiveFilters([])}>
            Show all
          </button>
        </div>
      )}

      {shown.length > 0 && (
        <div className="board__cols">
          {PHASES.map((name, p) => {
            const colItems = shown.filter((it) => phaseIdx(it) === p)
            const colActiveCount = colItems.filter((it) => !isAbandoned(it)).length
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
                  <span className="col__count">{colActiveCount}</span>
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
      )}
    </div>
  )
}
