import { useRef, useState, useSyncExternalStore } from 'react'
import {
  PHASES,
  ACCEPT_GATE_INDEX,
  isClosed,
  isAbandoned,
  curStep,
  phaseIdx,
  awaitingGate,
  phasesFor,
  itemKindOf,
  itemKindInfo,
  isItemKind,
} from '../../../domain/js/lifecycle.js'
import { PHASE_ACCENT, PHASE_ACCENT_BG, priorityColor } from '../domain/lifecycle'
import { FILTERS, DEFAULT_ACTIVE_FILTERS, visibleItems, hiddenCounts, matchCounts } from '../domain/filters'
import { activeChips, chipPatch } from '../domain/filterChips'
import { KIND_OPTIONS, SORT_LABELS, isAtSubstep, narrowItems, planPool, sortByWait, waitText } from '../domain/narrowing'
import { PRIORITIES } from '../../../domain/js/priorities.js'
import { currentSubstep } from '../../../domain/js/substeps.js'
import { PRIMARY_PERSONA_AGENT, personaFor } from '../domain/personas'
import { itemStatus, stateLabel, isDependencyBlocked, isRuleBlocked, ruleBlockSummary, queuedToMerge } from '../domain/status'
import { gateActionOf, gateActionBusy, elapsedText } from '../domain/gateAction'
import { usualDurationHint } from '../domain/durationHint'
import { deployQueueLabel } from '../domain/deployQueue'
import { useClockTick } from '../useClockTick'
import { MOBILE_QUERY, useMediaQuery } from '../useMediaQuery'
import { issueUrl, issueLabel } from '../api'
import * as boardFilters from '../boardFilters'
import * as boardNarrowing from '../boardNarrowing'
import StatusPill, { AutopilotOffChip, autopilotOffShown, AUTOPILOT_OFF_GATE_NOTE } from './StatusPill'
import DependencyBadge, { itemHref } from './DependencyBadge'
import GateActionStatus from './GateActionStatus'
import ProjectBadge from './ProjectBadge'
import TaskBadge from './TaskBadge'
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

function BoardCard({ item, projects, durationEstimates, deployBlock, viewerName, now, showWait, planKind, onOpen, onOpenPlan, onApprove, onReject, onTogglePause, isGateBusy }) {
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
  // HZ-540: the sub-step the item is at, from its snapshot. The card stays in
  // its anchor's column.
  const substep = currentSubstep(item)

  return (
    <div className={`card${awaiting ? ' card--awaiting' : ''}`} onClick={() => onOpen(item.id)}>
      <div className="card__meta">
        <span className="card__dot" style={{ background: priorityColor(item.priority) }} />
        <span className="card__id">{item.id}</span>
        <ProjectBadge projectId={item.project_id} projects={projects} />
        <TaskBadge kind={item.kind} />
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
        <span className="card__phase">{phasesFor(itemKindOf(item))[phaseIdx(item)]}</span>
        <span
          className="card__persona"
          style={{ color: personaFor(item, PRIMARY_PERSONA_AGENT).color }}
          title="Eng specialist persona"
        >
          {personaFor(item, PRIMARY_PERSONA_AGENT).label}
        </span>
        <StatusPill status={itemStatus(item, false, { deployBlock })} />
      </div>
      {substep && (
        <div className="card__substep" data-testid="card-substep">
          <span className="card__substep-label">{substep.label}</span>
          {substep.personaBadge && (
            <span className="card__substep-persona" style={{ color: substep.personaBadge.color }} title="Sub-step persona">
              {substep.personaBadge.label}
            </span>
          )}
        </div>
      )}
      {/* HZ-443: under Waiting on me, one wait per card — from when it began
          waiting, so it replaces the state's elapsed line. */}
      {showWait && <div className="card__waiting">{waitText(item.waiting_since, now)}</div>}
      {!showWait && elapsedLabel && (
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
      <AutopilotOffChip item={item} />
      <DependencyBadge item={item} compact planKind={planKind} onOpenPlan={onOpenPlan} />

      {awaiting && (
        <div className="card__gate">
          <div className="card__gate-label">
            <LockIcon size={13} strokeWidth={2.4} />
            {cur.label}
            {autopilotOffShown(item) && ` · ${AUTOPILOT_OFF_GATE_NOTE}`}
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

// HZ-586: the phone column switcher — one tab per lifecycle column, with its
// number and card count; the shown column's own head names it. Arrow keys,
// Home and End move between tabs (roving tabIndex).
function PhaseTabs({ counts, active, onSelect }) {
  const tabs = useRef([])
  const select = (p) => {
    onSelect(p)
    tabs.current[p]?.focus()
  }
  const onKeyDown = (e) => {
    const last = PHASES.length - 1
    const next = { ArrowRight: active === last ? 0 : active + 1, ArrowLeft: active === 0 ? last : active - 1, Home: 0, End: last }[e.key]
    if (next === undefined) return
    e.preventDefault()
    select(next)
  }
  return (
    <div className="board__tabs" role="tablist" aria-label="Board columns" onKeyDown={onKeyDown}>
      {PHASES.map((name, p) => (
        <button
          key={name}
          ref={(el) => {
            tabs.current[p] = el
          }}
          type="button"
          role="tab"
          id={`board-tab-${p}`}
          className="board__tab"
          aria-selected={p === active}
          aria-controls={p === active ? `board-col-${p}` : undefined}
          aria-label={`${name}, ${counts[p]} ${counts[p] === 1 ? 'item' : 'items'}`}
          tabIndex={p === active ? 0 : -1}
          onClick={() => onSelect(p)}
        >
          <span className="col__num" style={{ background: PHASE_ACCENT_BG[p], color: PHASE_ACCENT[p] }}>
            {p + 1}
          </span>
          <span className="board__tab-count">{counts[p]}</span>
        </button>
      ))}
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
  planProgress = [],
  onOpenPlan,
}) {
  const activeFilterKeys = useSyncExternalStore(boardFilters.subscribe, boardFilters.getActiveFilters)
  const view = useSyncExternalStore(boardNarrowing.subscribe, boardNarrowing.getBoardView)
  // HZ-228: one clock tick for the whole Board, once a minute while any card
  // shows an elapsed label — cards start no timers of their own.
  useClockTick(60_000, items.some((it) => it.state_since || (view.waiting && it.waiting_since)))
  const now = new Date()
  // HZ-547: a chosen Plan narrows the board to what it filed, open or closed,
  // before anything else — so the hide filters and chips below count and
  // combine within that Plan's items.
  const plans = new Map(planProgress.map((p) => [p.id, p]))
  const plan = view.plan == null ? null : (plans.get(view.plan) ?? { id: view.plan, kind: null, title: null })
  const pool = planPool(items, view.plan)
  // Filtering is a view concern only — it narrows what's rendered here, and
  // never touches an item or what the farm dispatches (HZ-80).
  const shown = visibleItems(pool, activeFilterKeys, now)
  // HZ-443: then the narrowing controls, over what the hide filters left.
  const narrowed = narrowItems(shown, view)
  const filtered = shown.length - narrowed.length
  const hidden = hiddenCounts(pool, activeFilterKeys, now)
  const matches = matchCounts(pool, now)
  const totalHidden = Object.values(hidden).reduce((sum, n) => sum + n, 0) + filtered
  const hiddenSummary = [
    ...FILTERS.filter((f) => hidden[f.key] > 0).map((f) => `${hidden[f.key]} ${f.noun}`),
    ...(filtered > 0 ? [`${filtered} filtered`] : []),
  ].join(', ')
  // Abandoned items that are still shown (their filter toggled off) don't
  // count as active work: they've stopped being dispatched.
  const activeCount = narrowed.filter((it) => !isAbandoned(it)).length
  // Each lifecycle column's cards, built once for the columns and the phone tabs.
  const cols = PHASES.map((name, p) => {
    const inCol = narrowed.filter((it) => phaseIdx(it) === p)
    const colItems = view.waiting ? sortByWait(inCol, view.sortDir) : inCol
    return { name, p, colItems, activeCount: colItems.filter((it) => !isAbandoned(it)).length }
  })
  // HZ-586: a phone shows one column at a time, full width, picked from the
  // tabs above it. Back to Plan when the board remounts.
  const phone = useMediaQuery(MOBILE_QUERY)
  const [phonePhase, setPhonePhase] = useState(0)
  // HZ-547: with a Plan chosen, Show all shows every item it filed, closed
  // ones too, and keeps the Plan and the chips.
  const showAll = () => {
    boardFilters.setActiveFilters([])
    if (plan == null) boardNarrowing.clearBoardView()
  }
  // HZ-601: what is narrowing the board, one removable chip per filter.
  const chips = activeChips(view, activeFilterKeys)
  const removeChip = (key) => {
    const patch = chipPatch(key)
    if (patch?.hide) boardFilters.toggleFilter(patch.hide)
    else if (patch?.view) boardNarrowing.setBoardView(patch.view)
  }
  // Back to the defaults: every default-on hide filter on, nothing narrowed.
  const clearAll = () => {
    boardFilters.setActiveFilters(DEFAULT_ACTIVE_FILTERS)
    boardNarrowing.clearBoardView()
  }
  const planKindLabel = (kind) => itemKindInfo(isItemKind(kind) ? kind : 'plan').label
  // HZ-540: offered only while some item is at a sub-step, or it is on.
  const showSubstepChip = view.substep || pool.some(isAtSubstep)
  const chip = (on, label, onClick) => (
    <button
      key={label}
      type="button"
      className={`board__narrow-chip${on ? ' board__narrow-chip--active' : ''}`}
      aria-pressed={on}
      onClick={onClick}
    >
      {label}
    </button>
  )

  return (
    <div className="board">
      <div className="board__head">
        <div className="board__title">Work in flight</div>
        <div className="board__meta">
          {plan == null ? `${activeCount} items across the lifecycle` : `${activeCount} items from ${planKindLabel(plan.kind)} ${plan.id}`}
        </div>
        {totalHidden > 0 && narrowed.length > 0 && (
          <div className="board__hidden-note">
            Hiding {hiddenSummary}
            <button className="board__show-all" onClick={showAll}>
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

      {chips.length > 0 && (
        <div className="board__filterbar" role="group" aria-label="Active filters">
          <span className="board__filterbar-count">Filters · {chips.length}</span>
          {chips.map((c) => (
            <span key={c.key} className="board__chip">
              <span className="board__chip-label" title={c.label}>
                {c.label}
              </span>
              <button
                type="button"
                className="board__chip-remove"
                aria-label={`Remove ${c.label} filter`}
                onClick={() => removeChip(c.key)}
              >
                ×
              </button>
            </span>
          ))}
          <button type="button" className="board__clear-all" onClick={clearAll}>
            Clear all
          </button>
        </div>
      )}

      <div className="board__narrow">
        <div className="board__narrow-group">
          {chip(view.waiting, 'Waiting on me', () => boardNarrowing.setBoardView({ waiting: !view.waiting }))}
          {view.waiting && (
            <button
              type="button"
              className="board__narrow-chip board__sort-toggle"
              title="Sort order — click to flip"
              onClick={() => boardNarrowing.setBoardView({ sortDir: view.sortDir === 'newest' ? 'oldest' : 'newest' })}
            >
              {SORT_LABELS[view.sortDir]}
            </button>
          )}
          {showSubstepChip && chip(view.substep, 'At a sub-step', () => boardNarrowing.setBoardView({ substep: !view.substep }))}
        </div>
        <div className="board__narrow-group" role="group" aria-label="Priority">
          <span className="board__narrow-label" aria-hidden="true">
            Priority
          </span>
          {PRIORITIES.map((p) => chip(view.priorities.includes(p), p, () => boardNarrowing.toggleIn('priorities', p)))}
        </div>
        <div className="board__narrow-group" role="group" aria-label="Kind">
          <span className="board__narrow-label" aria-hidden="true">
            Kind
          </span>
          {KIND_OPTIONS.map((k) => chip(view.kinds.includes(k.key), k.label, () => boardNarrowing.toggleIn('kinds', k.key)))}
        </div>
        {(plan != null || planProgress.length > 0) && (
          <div className="board__narrow-group" role="group" aria-label="Plan">
            <span className="board__narrow-label" aria-hidden="true">
              Plan
            </span>
            {plan == null ? (
              <select
                className="board__narrow-chip board__plan-select"
                aria-label="Plan"
                value=""
                onChange={(e) => e.target.value && boardNarrowing.setBoardView({ plan: e.target.value })}
              >
                <option value="">Any</option>
                {planProgress.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id} · {p.title}
                  </option>
                ))}
              </select>
            ) : (
              <span className="board__plan-chip" title={plan.title ? `${plan.id} · ${plan.title}` : plan.id}>
                <span className="board__plan-chip-label">{plan.title ? `${plan.id} · ${plan.title}` : plan.id}</span>{' '}
                <button
                  type="button"
                  className="board__plan-clear"
                  aria-label="Clear the Plan filter"
                  onClick={() => boardNarrowing.setBoardView({ plan: null })}
                >
                  ×
                </button>
              </span>
            )}
          </div>
        )}
      </div>

      {items.length === 0 && <div className="board__empty">No work items yet.</div>}

      {items.length > 0 && pool.length === 0 && (
        <div className="board__empty">
          No items from {planKindLabel(plan.kind)} {plan.id}.{' '}
          <button className="board__show-all" onClick={() => boardNarrowing.setBoardView({ plan: null })}>
            Clear
          </button>
        </div>
      )}

      {pool.length > 0 && shown.length === 0 && (
        <div className="board__empty">
          All {pool.length} items are hidden by the active filters.{' '}
          <button className="board__show-all" onClick={showAll}>
            Show all
          </button>
        </div>
      )}

      {shown.length > 0 && narrowed.length === 0 && (
        <div className="board__empty">
          No items match the selected filters.{' '}
          <button className="board__show-all" onClick={boardNarrowing.clearBoardView}>
            Clear
          </button>
        </div>
      )}

      {narrowed.length > 0 && phone && (
        <PhaseTabs counts={cols.map((c) => c.activeCount)} active={phonePhase} onSelect={setPhonePhase} />
      )}

      {narrowed.length > 0 && (
        <div className={phone ? 'board__cols board__cols--phone' : 'board__cols'}>
          {(phone ? [cols[phonePhase]] : cols).map(({ name, p, colItems, activeCount: colActiveCount }) => {
            return (
              <div
                key={name}
                className="col"
                {...(phone && { id: `board-col-${p}`, role: 'tabpanel', 'aria-labelledby': `board-tab-${p}` })}
              >
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
                      showWait={view.waiting}
                      planKind={item.spawnedBy ? (plans.get(item.spawnedBy.id)?.kind ?? null) : null}
                      onOpen={onOpen}
                      onOpenPlan={onOpenPlan}
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
