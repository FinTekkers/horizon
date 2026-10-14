// HZ-236: step 9's overlap check against every other in-flight item in the
// same repo and project. computeOverlap only reads — other items' step-6 plans
// and PR file lists. applyOverlap makes the only two writes the check may make:
// a dependency edge on THIS item, and a contract queued as feedback on both
// items. Neither cancels, pauses, re-kicks or reorders anything.

import { db } from './db.js'
import { getItem, latestArtifact, addDependency, queueFeedbackOnce, overlapLinkRemoval, addEvent } from './store.js'
import { getPrFiles } from './github.js'
import { DEPLOY_STEP_INDEX, requiredStepIndex } from '../../domain/js/lifecycle.js'
import { extractPlanFootprint, footprintFromPrFiles, isEmptyFootprint, decideOverlap, contractText, peerStateOf } from './overlap.js'

export const PLAN_STEP_INDEX = requiredStepIndex('Draft implementation plan')
export const SUMMARIZE_STEP_INDEX = requiredStepIndex('Summarize reviews & recommend')
export const OVERLAP_INPUT_LABEL = 'Overlap check (deterministic)'

// Steps 6–14: from the implementation plan up to and including Deploy the
// changes (HZ-466: merged-but-not-deployed peers still count). Abandoned
// items are out; closed items sit past this range already.
const selectPeers = db.prepare(
  `SELECT * FROM work_item
   WHERE repo = ? AND project_id IS ? AND id <> ? AND abandoned_at IS NULL AND cursor BETWEEN ? AND ?
   ORDER BY id`,
)

export function inFlightPeers(item) {
  if (!item?.repo) return []
  return selectPeers.all(item.repo, item.project_id ?? null, item.id, PLAN_STEP_INDEX, DEPLOY_STEP_INDEX)
}

// Tests only: replaces computeOverlap's body, e.g. with one that throws.
let computeOverride = null
export function setComputeOverlapForTest(fn) {
  computeOverride = fn
}

// An item's footprint from its newest done step-6 plan, else its PR diff.
// Returns { fp, sourceLabel } or { reason } — never an empty footprint, so an
// unreadable item is reported as not checked instead of as `none`.
// HZ-466: `preferPr` (a peer that can be linked to) reads the PR diff first —
// real code, not intent — and falls back to the plan if the read fails or
// names nothing.
async function footprintOf(row, { preferPr = false } = {}) {
  const plan = latestArtifact(row.id, PLAN_STEP_INDEX)
  const planFp = plan ? extractPlanFootprint(plan) : null
  const fromPlan = planFp && !isEmptyFootprint(planFp) ? { fp: planFp, sourceLabel: 'step-6 plan' } : null
  if (fromPlan && !preferPr) return fromPlan
  if (row.pr != null) {
    let files
    try {
      files = await getPrFiles(row)
    } catch (err) {
      return fromPlan || { reason: `PR #${row.pr}'s file list is unavailable: ${err.message}` }
    }
    const fp = footprintFromPrFiles(files)
    if (!isEmptyFootprint(fp)) return { fp, sourceLabel: `PR #${row.pr} diff` }
    return fromPlan || { reason: `PR #${row.pr} lists no changed files${plan ? ' and its step-6 plan names none' : ''}` }
  }
  if (fromPlan) return fromPlan
  return { reason: plan ? 'its step-6 plan names no files or functions, and it has no PR' : 'no step-6 plan and no PR' }
}

const notChecked = (row, reason) => ({ id: row.id, decision: 'not-checked', reason })

// Read-only. { repo, self: { id, sourceLabel, files?, symbols? }, results }.
export async function computeOverlap(itemId) {
  if (computeOverride) return computeOverride(itemId)
  const item = getItem(itemId)
  const peers = inFlightPeers(item)
  const own = await footprintOf(item)
  const self = own.fp
    ? { id: itemId, sourceLabel: own.sourceLabel, ...own.fp }
    : { id: itemId, sourceLabel: `not readable — ${own.reason}` }
  const results = []
  for (const peer of peers) {
    if (!own.fp) {
      results.push(notChecked(peer, `this item has nothing to compare (${own.reason})`))
      continue
    }
    const state = peerStateOf(peer)
    const theirs = await footprintOf(peer, { preferPr: state.linkable })
    if (!theirs.fp) {
      results.push(notChecked(peer, theirs.reason))
      continue
    }
    results.push({ id: peer.id, sourceLabel: theirs.sourceLabel, ...theirs.fp, ...decideOverlap(own.fp, theirs.fp, { id: peer.id, ...state }) })
  }
  return { repo: item?.repo ?? null, self, results }
}

// When computeOverlap itself fails, every peer is still listed — as not
// checked, with the reason — so a broken check never reads as `none`.
export function overlapFailure(itemId, err) {
  const item = getItem(itemId)
  let peers = []
  try {
    peers = inFlightPeers(item)
  } catch {
    // Listing peers failed too: the section says so via an empty list below.
  }
  const reason = `the overlap check failed: ${err?.message || err}`
  return {
    repo: item?.repo ?? null,
    self: { id: itemId, sourceLabel: `not readable — ${reason}` },
    results: peers.map((p) => notChecked(p, reason)),
  }
}

function queueContract(selfId, peerId, contract) {
  const outcomes = [selfId, peerId].sort().map((id) => ({ id, res: queueFeedbackOnce(id, { message: contract }) }))
  const failed = outcomes.filter((o) => o.res.error)
  if (failed.length > 0) return `contract could not be queued on ${failed.map((o) => `${o.id} (${o.res.error})`).join(', ')}`
  const queued = outcomes.filter((o) => o.res.queued).map((o) => o.id)
  const already = outcomes.filter((o) => o.res.duplicate).map((o) => o.id)
  return [
    queued.length > 0 ? `contract queued as feedback on ${queued.join(' and ')}` : null,
    already.length > 0 ? `contract already queued on ${already.join(' and ')}` : null,
  ]
    .filter(Boolean)
    .join('; ')
}

// Synchronous on purpose: completeFarmRun calls it after its last await and
// before marking step 9 done, with nothing in between — the dependency edge
// it adds blocks this item, and no re-check may see that mid-completion.
// Returns the results with an `effect` (and `contract`/`why`) on each entry.
// HZ-466: every overlap queues the contract, a depends-on one included, and a
// pair whose overlap link an owner removed gets the contract instead of the
// link. Edges are only ever added here — never removed or edited.
export function applyOverlap(itemId, check) {
  const results = check.results.map((r) => {
    if (r.decision !== 'depends-on' && r.decision !== 'shared-contract') return r
    try {
      const contract = contractText(itemId, r.id, r.sharedFiles, r.sharedSymbols)
      if (r.decision === 'depends-on') {
        const removal = overlapLinkRemoval(itemId, r.id)
        if (removal) {
          addEvent(itemId, {
            who: 'Horizon',
            text: `did not re-add the overlap dependency on ${r.id}: ${removal.removed_by} removed it on ${removal.removed_at}`,
            color: '#5E4380',
            initials: 'HZ',
          })
          return {
            ...r,
            decision: 'shared-contract',
            contract,
            why: `owner ${removal.removed_by} removed this link on ${removal.removed_at}`,
            effect: queueContract(itemId, r.id, contract),
          }
        }
        const res = addDependency(itemId, r.id, 'Horizon')
        if (res.ok) {
          const what = res.unchanged ? `dependency ${itemId} → ${r.id} already present` : `added dependency ${itemId} → ${r.id}`
          return { ...r, contract, effect: `${what}; blocked until ${r.id} closes (shown on the card); ${queueContract(itemId, r.id, contract)}` }
        }
        if (res.error !== 'cycle') return notChecked(r, `could not add the dependency (${res.error})`)
        return {
          ...r,
          decision: 'shared-contract',
          contract,
          why: `a dependency ${itemId} → ${r.id} would close a cycle — ${res.message}`,
          effect: queueContract(itemId, r.id, contract),
        }
      }
      return { ...r, contract, effect: queueContract(itemId, r.id, contract) }
    } catch (err) {
      return notChecked(r, `applying the decision failed: ${err.message}`)
    }
  })
  return { ...check, results }
}
