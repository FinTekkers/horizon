// Shared status presentation for a work item (board card + tracker header).

import { isClosed, isAbandoned, curStep, awaitingGate } from '../../../domain/js/lifecycle.js'
import { AGENTS } from './agentTokens'
import { gateActionOf } from './gateAction'

// A dispatched step whose run the farm currently reports as queued rather
// than running (HZ-54) — distinct from a step merely "not yet reached"
// (stepStatus's 'pending'). item.activeRun.state defaults to 'running' at
// the data layer (store.js) whenever the farm is mock/unreachable/silent on
// the field, so this only ever fires on a real, current signal.
export function isQueued(item) {
  return !!item.activeRun && item.activeRun.step_index === item.cursor && item.activeRun.state === 'queued'
}

// HZ-335: an item held up by an open dependency, read from the API's
// item.blocked as given (HZ-95: no client-side derivation). Nothing runs for
// it, so it must never look like an agent is working or offer Pause work.
// False once the item is closed, abandoned, rejected or paused — those states
// win — and while a run is actually running at the cursor (a dependency added
// mid-run: real work is happening). A queued run still counts as blocked.
export function isDependencyBlocked(item) {
  if (!item.blocked) return false
  if (isClosed(item) || isAbandoned(item) || item.rejected || item.paused) return false
  const run = item.activeRun
  return !(run && run.step_index === item.cursor && run.state === 'running')
}

// HZ-346: an implement run stopped on a rule with no code changes, read from
// the API's item.ruleBlock as given. Nothing runs for it until a dependency
// it gained closes or a human resumes it. Closed, abandoned, rejected and
// paused win, as for isDependencyBlocked.
export function isRuleBlocked(item) {
  if (!item.ruleBlock) return false
  return !(isClosed(item) || isAbandoned(item) || item.rejected || item.paused)
}

// verbose=true gives the tracker-header phrasing; false gives the compact card one.
export function itemStatus(item, verbose = false) {
  const closed = isClosed(item)
  const abandoned = isAbandoned(item)
  const rejected = item.rejected && !closed && !abandoned
  const paused = !!item.paused && !closed && !abandoned && !rejected
  const awaiting = awaitingGate(item)
  const cur = curStep(item)

  // Abandoned is its own terminal state, distinct from Closed — reusing
  // cursor >= STEPS.length would make it indistinguishable from delivered
  // work in every count and view (the exact flaw HZ-59 exists to fix).
  // Uses --deep/--accent-bg: the only free token pair that stays distinct
  // from rejected (danger), paused (muted) and closed (success) in both themes.
  if (abandoned) return { label: 'Abandoned', color: 'var(--deep)', bg: 'var(--accent-bg)' }
  if (closed) return { label: 'Closed', color: 'var(--success-ink)', bg: 'var(--success-bg)' }
  if (rejected) return { label: 'Changes requested', color: 'var(--danger-ink)', bg: 'var(--danger-bg)' }
  if (paused) return { label: 'Paused', color: 'var(--muted-strong)', bg: 'var(--chip)' }
  // Precedence (HZ-335): Abandoned > Closed > Changes requested > Paused >
  // Blocked by a rule (HZ-346) > Blocked > Awaiting > Queued > working.
  // Danger is what "blocked" already means on the board (.dep-pill--blocked,
  // step__icon--blocked).
  if (isRuleBlocked(item)) return { label: 'Blocked by a rule', color: 'var(--danger-ink)', bg: 'var(--danger-bg)' }
  if (isDependencyBlocked(item)) return { label: 'Blocked', color: 'var(--danger-ink)', bg: 'var(--danger-bg)' }
  if (awaiting) {
    return { label: verbose ? 'Awaiting your approval' : 'Awaiting you', color: 'var(--warning-ink)', bg: 'var(--warning-bg)' }
  }
  if (isQueued(item)) {
    return { label: 'Queued', color: '#8C8C8E', bg: '#EDEDEF', reason: item.activeRun.reason || undefined }
  }
  const agent = AGENTS[cur.agent]
  return { label: verbose ? `${agent.label} working` : agent.label, color: 'var(--primary-ink)', bg: 'var(--primary-bg)' }
}

// HZ-228: a short name for each agent step, so the card's elapsed line fits
// one line at the Board's card width. Keyed by `agent:phase` from
// domain/steps.json, never by label text; a step with no entry shows its own
// label (status.test.js checks every agent step has one).
const STEP_STATE_LABEL = {
  'PM:0': 'Defining the outcome',
  'Architect:0': 'Setting guardrails',
  'Ensemble:1': 'Planning options',
  'Eng:1': 'Drafting the plan',
  'Architect:1': 'Architecture review',
  'QA:1': 'QA review',
  'PM:1': 'Summarizing reviews',
  'Eng:2': 'Implementing',
  'Review:2': 'Automated review',
  'DevOps:3': 'Deploying',
}

export function stepStateLabel(step) {
  return STEP_STATE_LABEL[`${step.agent}:${step.phase}`] ?? step.label
}

// What the card's elapsed line names, e.g. 'Implementing' or 'Waiting on you',
// or null for no timer. Paused rule: a paused card shows no timer — there is
// no pause timestamp to count from, and adding one would be a schema change.
// Closed, abandoned and rejected cards show none either; the server sends
// state_since: null for all four. A dependency-blocked card shows none: the
// API has no blocked-since time (HZ-335).
export function stateLabel(item) {
  if (!item.state_since) return null
  if (isClosed(item) || isAbandoned(item) || item.rejected || item.paused) return null
  if (isDependencyBlocked(item) || isRuleBlocked(item)) return null
  const cur = curStep(item)
  if (cur.kind === 'gate') {
    const action = gateActionOf(item)
    if (action?.state === 'running') return action.kind === 'resolve' ? 'Resolving conflicts' : 'Running checks'
    return 'Waiting on you'
  }
  return stepStateLabel(cur)
}
