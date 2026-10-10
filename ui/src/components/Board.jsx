import { useRef, useState, useSyncExternalStore } from 'react'
import {
  PHASES,
  ACCEPT_GATE_INDEX,
  isClosed,
  isAbandoned,
  curStep,
  phaseIdx,
  awaitingGate,
} from '../../../domain/js/lifecycle.js'
import { PHASE_ACCENT, PHASE_ACCENT_BG, priorityColor } from '../domain/lifecycle'
import { FILTERS, visibleItems, hiddenCounts, matchCounts } from '../domain/filters'
import { PRIMARY_PERSONA_AGENT, personaFor } from '../domain/personas'
import { itemStatus, stateLabel, isDependencyBlocked, isRuleBlocked, ruleBlockSummary, queuedToMerge } from '../domain/status'
import { gateActionOf, gateActionBusy, elapsedText } from '../domain/gateAction'
import { usualDurationHint } from '../domain/durationHint'
import { deployQueueLabel } from '../domain/deployQueue'
import { useClockTick } from '../useClockTick'
import { issueUrl, issueLabel } from '../api'
import * as boardFilters from '../boardFilters'
import StatusPill from './StatusPill'
import DependencyBadge, { itemHref } from './DependencyBadge'
import GateActionStatus from './GateActionStatus'
import ProjectBadge from './ProjectBadge'
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

function BoardCard({ item, projects, durationEstimates, deployBlock, viewerName, now, onOpen, onApprove, onReject, onTogglePause, isGateBusy }) {
  const closed = isClosed(item)
  const abandoned = isAbandoned(item)
  const rejected = item.rejected && !closed && !abandoned
  const paused = !!item.paused && !closed && !abandoned && !rejected
  const awaiting = awaitingGate(item)
  const cur = curStep(item)
  // HZ-335: a dependency-blocked item has nothing running, so no Pause work.
  const blocked = isDependencyBlocked(item)
  // HZ-365: nor does a rule-blocked one.
  const ruleBlocked = isRuleBlocked(item)
  const isActiveAgent =
    !closed && !abandoned && !awaiting && !rejected && !paused && !blocked && !ruleBlocked && cur && cur.kind === 'agent'
  const rejectTarget = awaiting && cur ? cur.label : cur ? cur.label : 'this step'
  // HZ-385: each button sends the state it shows, once at a time, as the
  // Tracker's does.
  const pauseInFlight = useRef(false)
  const [pauseBusy, setPauseBusy] = useState(false)
  const [pauseFailed, setPauseFailed] = useState(false)
  const sendPause = (e, wantPaused) => {
    e.stopPropagation()
    if (pauseInFlight.current) return
    pauseInFlight.current = true
    setPauseBusy(true)
    setPauseFailed(false)
    new Promise((resolve) => resolve(onTogglePause(item.id, wantPaused)))
      .then(
        () => false,
        () => true,
      )
      .then((failed) => {
        pauseInFlight.current = false
        setPauseBusy(false)
        setPauseFailed(failed)
      })
  }
  // HZ-226: at the Accept gate, the server's in-flight action (pre-merge
  // checks + merge, or conflict resolution) shows here as it does on the
  // Tracker. While it runs the line replaces the gate buttons; any finished
  // state brings them back. Cards at any other gate never show it.
  // HZ-279: isGateBusy is App.jsx's, so this tab's in-flight Accept hides the
  // buttons too, before the first push.
  const atAccept = awaiting && item.cursor === ACCEPT_GATE_INDEX
  const gateAction = atAccept ? gateActionOf(item) : null
  const gateRunning = atAccept && isGateBusy(item)
  // HZ-360: a Horizon deploy holds the merge. The gate shows why and who
  // approved, with no Approve or Send back until the deploy ends.
  const queued = queuedToMerge(item, deployBlock, viewerName)
  // HZ-228: how long the item has been in its current state, ticked by the
  // Board's one shared clock (`now`).
  const elapsedLabel = stateLabel(item, { deployBlock })
  // HZ-230: 'usually ~20m' (or 'running long') from the snapshot's estimates.
  const hint = usualDurationHint(item, durationEstimates, now)

  return (
    <div className={`card${awaiting ? ' card--awaiting' : ''}`} onClick={() => onOpen(item.id)}>
      <div className="card__meta">
        <span className="card__dot" style={{ background: priorityColor(item.priority) }} />
        <span className="card__id">{item.id}</span>
        <ProjectBadge projectId={item.project_id} projects={projects} />
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
        <span
          className="card__persona"
          style={{ color: personaFor(item, PRIMARY_PERSONA_AGENT).color }}
          title="Eng specialist persona"
        >
          {personaFor(item, PRIMARY_PERSONA_AGENT).label}
        </span>
        <StatusPill status={itemStatus(item, false, { deployBlock })} />
      </div>
      {elapsedLabel && (
        <div className="card__elapsed">
          {elapsedLabel} · {elapsedText(item.state_since, now, { seconds: false })}
          {hint && (
            <>
              {' · '}
              <span className={`card__usual${hint.long ? ' card__usual--long' : ''}`}>{hint.text}</span>
            </>
          )}
        </div>
      )}
      {deployQueueLabel(item) && <div className="card__deploy-queue">{deployQueueLabel(item)}</div>}
      {/* HZ-365: the first line of what's needed, as plain text; the link
          lands on the item page's banner, which holds the rest. */}
      {ruleBlocked && (
        <div className="card__rule-block">
          {ruleBlockSummary(item.ruleBlock.needs).summary}
          <a
            className="card__rule-block-link"
            href={`${itemHref(item.id)}#rule-block`}
            onClick={(e) => e.stopPropagation()}
          >
            See what to do
          </a>
        </div>
      )}
      <DependencyBadge item={item} compact />

      {awaiting && (
        <div className="card__gate">
          <div className="card__gate-label">
            <LockIcon size={13} strokeWidth={2.4} />
            {cur.label}
          </div>
          {queued && (
            <div className="card__queued">
              <div>Queued to merge: {queued.text}</div>
              {queued.approvedBy && <div className="card__queued-by">{queued.approvedBy}</div>}
            </div>
          )}
          {gateAction && (
            <GateActionStatus
              action={gateAction}
              pr={item.pr}
              showElapsed={false}
              onRetry={queued ? undefined : () => onApprove(item.id, cur.label)}
              retryDisabled={gateRunning}
            />
          )}
          {!gateRunning && !queued && (
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
          )}
        </div>
      )}

      {isActiveAgent && (
        <button
          className="btn-pause"
          disabled={pauseBusy}
          aria-busy={pauseBusy || undefined}
          onClick={(e) => sendPause(e, true)}
        >
          Pause work
        </button>
      )}

      {paused && (
        <button
          className="btn-resume"
          disabled={pauseBusy}
          aria-busy={pauseBusy || undefined}
          onClick={(e) => sendPause(e, false)}
        >
          Resume work
        </button>
      )}

      {pauseFailed && <span role="alert">That did not go through — try again.</span>}
    </div>
  )
}

export default function Board({
  items,
  projects,
  durationEstimates,
  deployBlock = null,
  viewerName = null,
  onOpen,
  onApprove,
  onReject,
  onTogglePause,
  onNewItem,
  isGateBusy = gateActionBusy,
}) {
  const activeFilterKeys = useSyncExternalStore(boardFilters.subscribe, boardFilters.getActiveFilters)
  // HZ-228: one clock tick for the whole Board, once a minute while any card
  // shows an elapsed label — cards start no timers of their own.
  useClockTick(60_000, items.some((it) => it.state_since))
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
                      projects={projects}
                      durationEstimates={durationEstimates}
                      deployBlock={deployBlock}
                      viewerName={viewerName}
                      now={now.getTime()}
                      onOpen={onOpen}
                      onApprove={onApprove}
                      onReject={onReject}
                      onTogglePause={onTogglePause}
                      isGateBusy={isGateBusy}
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
