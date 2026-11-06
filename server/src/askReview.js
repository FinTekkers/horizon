// HZ-729: every open ask gets one independent review before anyone can accept
// it. The reviewer runs on a provider other than the ask's author — the
// project's `ask_review_provider`, else Muse — and checks the draft for fit
// with the project rules, overlap with open work and shape. Its verdict is
// accept, amend (with the edited draft) or escalate, with reasons.
//
// HZ-793: nothing files an ask but the owner, so the review is what the owner
// decides on. It also sees the project's other open items, its items
// abandoned in the last 14 days, the other open asks from the same step, and
// the parent item's description, and says whether the ask contradicts it.
// Every one of those comes from the ask's own project only.
//
// Same pattern as caretakerRuling.js: a server-side sweep, one bounded farmd
// call (POST /ask/review → farm/ask_review.py, no tools, one turn), and the
// reply checked here in code before it is stored.
//
// Review only: this module writes the ask_review table and nothing else. It
// never files, dismisses or edits an item or an ask, and adds no dependency.
// The overlap check is run read-only (never applyOverlap). The only GitHub
// call reachable from here is overlapService's PR file-list read.
//
// No fallback: one provider is chosen or nothing runs. When that provider is
// usage-limited, not authenticated, or cannot be chosen at all, the review
// stays 'awaiting' with a stated reason and a later sweep tries again.

import { db } from './db.js'
import * as store from './store.js'
import { farmFetch } from './orchestrator.js'
import { stepLabel, validateAsk } from './asks.js'
import { footprintOf, inFlightPeers, planFootprintOf } from './overlapService.js'
import { decideOverlap, extractPlanFootprint, isEmptyFootprint, peerStateOf } from './overlap.js'
import { servedRulesFor } from './rulesStore.js'
import { redact } from './caretakerRules.js'
import { hasHostPath, stripHostPaths } from './planText.js'
import { formatResetTime, resetMs } from './usageLimits.js'
import { DEFAULT_PROVIDER, PROVIDERS, defaultModel, parseChoice, providerNames } from '../../domain/js/providers.js'
import { resolveModel } from '../../domain/js/personas.js'
import { PLAN_DRAFT_STEP_INDEX, STEPS, isClosed } from '../../domain/js/lifecycle.js'

// The owner's ruling: Muse reviews unless the project names another provider.
export const REVIEW_DEFAULT_PROVIDER = 'muse'
// The reviewer's model is the PM's on Claude, as for a Caretaker ruling.
const REVIEW_MODEL_AGENT = 'pm'
// Every key the body sent to farmd may carry — the draft, the project rules,
// the overlap matches and candidates, the parent item, and the ask's own
// metadata. Nothing else is sent: no transcript, artifact, host path, token
// or secret.
export const REVIEW_INPUT_KEYS = Object.freeze([
  'ask_id',
  'provider',
  'model',
  'step',
  'kind',
  'why',
  'project',
  'repo',
  'draft',
  'matches',
  'candidates',
  'abandoned',
  'siblings',
  'parent',
  'rules_override',
])
export const VERDICTS = ['accept', 'amend', 'escalate']
const MAX_REASONS = 6
const REASON_CHARS = 300
const MAX_CANDIDATES = 20
const MAX_SIBLINGS = 10
const ABANDONED_DAYS = 14
const PARENT_CHARS = 2000
const RESWEEP_MS = 60 * 1000
// One bounded model call on the farm; under farmFetch's header ceiling.
const REVIEW_FARM_MS = 180_000
const PLAN_KIND = STEPS[PLAN_DRAFT_STEP_INDEX].itemKind

const insertMissing = db.prepare(
  "INSERT OR IGNORE INTO ask_review (ask_id) SELECT id FROM ask WHERE status = 'open' AND id NOT IN (SELECT ask_id FROM ask_review)",
)
const selectAwaiting = db.prepare(
  `SELECT a.* FROM ask a JOIN ask_review r ON r.ask_id = a.id
    WHERE r.status = 'awaiting' AND a.status = 'open' ORDER BY a.id`,
)
const selectReview = db.prepare('SELECT * FROM ask_review WHERE ask_id = ?')
const selectRun = db.prepare('SELECT provider, runs_on FROM step_run WHERE id = ?')
const selectProject = db.prepare('SELECT name, ask_review_provider FROM project WHERE id = ?')
const selectRepos = db.prepare('SELECT repo FROM project_repo WHERE project_id = ?')
const selectPlans = db.prepare(
  'SELECT * FROM work_item WHERE kind = ? AND project_id = ? AND id <> ? AND abandoned_at IS NULL ORDER BY id',
)
// Every item in the project not abandoned, newest first; closed ones are
// dropped in code (isClosed), so no limit here can crowd out an open item.
const selectCandidates = db.prepare(
  `SELECT id, title, kind, cursor FROM work_item
    WHERE project_id = ? AND id <> ? AND abandoned_at IS NULL
    ORDER BY rowid DESC`,
)
const selectAbandoned = db.prepare(
  `SELECT id, title, kind, abandoned_reason FROM work_item
    WHERE project_id = ? AND id <> ? AND abandoned_at IS NOT NULL
      AND abandoned_at >= datetime('now', '-${ABANDONED_DAYS} days')
    ORDER BY abandoned_at DESC, rowid DESC LIMIT ${MAX_CANDIDATES}`,
)
// Same item, so always the same project.
const selectSiblings = db.prepare(
  `SELECT id, draft_json FROM ask
    WHERE item_id = ? AND step_index = ? AND id <> ? AND status = 'open'
    ORDER BY id LIMIT ${MAX_SIBLINGS}`,
)
const setWait = db.prepare(
  "UPDATE ask_review SET author_provider = ?, wait_reason = ?, updated_at = datetime('now') WHERE ask_id = ? AND status = 'awaiting'",
)
const claim = db.prepare(
  `UPDATE ask_review SET status = 'running', author_provider = ?, provider = ?, model = ?, input_json = ?, wait_reason = NULL,
          updated_at = datetime('now')
    WHERE ask_id = ? AND status = 'awaiting'`,
)
const release = db.prepare(
  "UPDATE ask_review SET status = 'awaiting', wait_reason = ?, updated_at = datetime('now') WHERE ask_id = ? AND status = 'running'",
)
const finish = db.prepare(
  `UPDATE ask_review SET status = ?, verdict = ?, reasons_json = ?, amended_draft_json = ?, refers_to_json = ?,
          contradiction_json = ?, updated_at = datetime('now')
    WHERE ask_id = ? AND status = 'running'`,
)

const oneLine = (text) => redact(text, { oneLine: false }).replace(/\s+/g, ' ').trim()
const clip = (text, max = REASON_CHARS) => (text.length > max ? text.slice(0, max - 1) + '…' : text)
// Text from other items and asks goes in redacted, not refused: one path in
// a sibling's draft must not stall this review for good.
const safe = (text, max = REASON_CHARS) => clip(stripHostPaths(oneLine(text ?? '')), max)
const labelOf = (name) => PROVIDERS.find((p) => p.name === name)?.label ?? name

function parseJson(text, fallback) {
  try {
    return text ? JSON.parse(text) : fallback
  } catch {
    return fallback
  }
}

// { provider } or { wait } — never the author's provider. The target is the
// project's setting, else Muse; when that is the author's, the first other
// provider in domain/providers.json's declared order. Anything unknown waits.
export function chooseReviewer({ authorProvider, projectSetting = null, providers = PROVIDERS }) {
  const names = providerNames(providers)
  if (typeof authorProvider !== 'string' || !names.includes(authorProvider)) {
    return { wait: 'the provider that wrote this ask is unknown, so a different one cannot be chosen' }
  }
  const setting = typeof projectSetting === 'string' && projectSetting.trim() ? projectSetting.trim() : null
  const target = setting ?? REVIEW_DEFAULT_PROVIDER
  if (!names.includes(target)) return { wait: `the project's ask review provider “${target}” is not a declared provider` }
  if (target !== authorProvider) return { provider: target }
  const other = names.find((name) => name !== authorProvider)
  return other ? { provider: other } : { wait: `no provider other than ${labelOf(authorProvider)} is declared` }
}

// The provider that wrote the ask: what its step run recorded, else the
// "<provider>:<model>" the run was dispatched on. null when neither is known.
export function authorProviderOf(ask) {
  const run = selectRun.get(ask.step_run_id)
  if (!run) return null
  if (typeof run.provider === 'string' && run.provider) return run.provider
  return parseChoice(run.runs_on)?.provider ?? null
}

// The exact model the review runs on: the provider's pinned default, or the
// PM's model on the default provider. The same id goes to farmd.
export function reviewerModel(provider) {
  const pinned = defaultModel(provider)
  if (pinned) return pinned
  return provider === DEFAULT_PROVIDER ? resolveModel(REVIEW_MODEL_AGENT) : null
}

// { ok: true } or { wait } when that exact model is usage-limited now. A
// limit on another model of the same provider does not block the review.
export function providerAvailable(provider, model, nowMs) {
  const until = store.activeModelLimits(nowMs).get(model)
  if (until == null) return { ok: true }
  return { wait: `${labelOf(provider)} (${model}) is usage-limited until ${formatResetTime(new Date(until).toISOString())}` }
}

const matchOf = (row, kind, d) => ({
  id: row.id,
  title: row.title,
  kind,
  decision: d.decision,
  sharedFiles: d.sharedFiles,
  sharedSymbols: d.sharedSymbols,
})

// Read-only. The draft's footprint (from its own text) against every
// in-flight item in the draft's repo and every open Plan in the project; the
// project's other open items, its items abandoned in the last 14 days, and
// the other open asks from the same step. An item with no project gets none.
export async function askOverlap(ask, draft, item) {
  const projectId = item?.project_id ?? null
  if (projectId == null) return { matches: [], candidates: [], abandoned: [], siblings: [] }
  const own = extractPlanFootprint([draft.title, draft.outcome, draft.metric, draft.guardrails].join('\n'))
  const matches = []
  if (!isEmptyFootprint(own)) {
    for (const peer of inFlightPeers({ id: ask.item_id, repo: draft.repo, project_id: projectId })) {
      const state = peerStateOf(peer)
      const theirs = await footprintOf(peer, { preferPr: state.linkable })
      if (!theirs.fp) continue
      const d = decideOverlap(own, theirs.fp, { id: peer.id, ...state })
      if (d.decision !== 'none') matches.push(matchOf(peer, peer.kind, d))
    }
    for (const plan of selectPlans.all(PLAN_KIND, projectId, ask.item_id)) {
      if (isClosed(plan)) continue
      const { fp } = planFootprintOf(plan, PLAN_DRAFT_STEP_INDEX)
      if (!fp) continue
      const d = decideOverlap(own, fp, { id: plan.id, linkable: false, state: 'an open Plan' })
      if (d.decision !== 'none') matches.push(matchOf(plan, PLAN_KIND, d))
    }
  }
  const candidates = selectCandidates
    .all(projectId, ask.item_id)
    .filter((r) => !isClosed(r))
    .slice(0, MAX_CANDIDATES)
    .map((r) => ({ id: r.id, title: safe(r.title), kind: r.kind, step: stepLabel(r.cursor) }))
  const abandoned = selectAbandoned
    .all(projectId, ask.item_id)
    .map((r) => ({ id: r.id, title: safe(r.title), kind: r.kind, reason: safe(r.abandoned_reason) }))
  const siblings = selectSiblings.all(ask.item_id, ask.step_index, ask.id).map((r) => {
    const d = parseJson(r.draft_json, {})
    return { ask_id: r.id, title: safe(d.title), outcome: safe(d.outcome) }
  })
  return { matches, candidates, abandoned, siblings }
}

// The item that raised the ask: its description redacted (line breaks kept)
// and clipped to PARENT_CHARS.
export function parentOf(item) {
  const description = stripHostPaths(redact(item?.desc ?? '', { oneLine: false })).trim()
  return { id: item?.id ?? '', title: safe(item?.title), description: clip(description, PARENT_CHARS) }
}

// The body sent to farmd, keyed by REVIEW_INPUT_KEYS only, or { refused }
// when any of it — the rules included — holds a token, secret or host path.
export function buildReviewInput(ask, draft, { provider, model, project, overlap, parent, rules }) {
  const body = {
    ask_id: ask.id,
    provider,
    model,
    step: stepLabel(ask.step_index),
    kind: ask.kind,
    why: ask.why,
    project: project ?? '',
    repo: draft.repo,
    draft,
    matches: overlap.matches,
    candidates: overlap.candidates,
    abandoned: overlap.abandoned ?? [],
    siblings: overlap.siblings ?? [],
    parent: parent ?? null,
    rules_override: rules,
  }
  const text = JSON.stringify(body)
  if (redact(text, { oneLine: false }) !== text) return { refused: 'the review input holds a token or secret' }
  if (hasHostPath(text)) return { refused: 'the review input holds a host path' }
  return { body }
}

// The reviewer's contradiction finding, or null when missing or malformed.
// null never forces a verdict: it only means "not checked".
function contradictionOf(reply) {
  const c = Object.hasOwn(reply, 'contradiction') ? reply.contradiction : null
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null
  if (c.contradicts === false) return { contradicts: false, detail: '' }
  if (c.contradicts !== true || typeof c.detail !== 'string') return null
  const detail = safe(c.detail)
  return detail ? { contradicts: true, detail } : null
}

// The farm's reply, never trusted. Always returns a verdict: anything this
// cannot use becomes 'escalate' with a reason saying why. `knownIds` are the
// matches', candidates' and abandoned items' ids: refers_to may name no other.
export function checkVerdict(reply, { provider, repos = [], knownIds = [], ask }) {
  let contradiction = null
  const escalate = (why) => ({ verdict: 'escalate', reasons: [why], amendedDraft: null, refersTo: [], contradiction })
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return escalate('the reviewer did not return a JSON object')
  if (reply.provider !== provider) {
    return escalate(`the review ran on ${oneLine(reply.provider ?? 'an unknown provider')}, not ${labelOf(provider)} as requested`)
  }
  const verdict = Object.hasOwn(reply, 'verdict') ? reply.verdict : undefined
  if (!VERDICTS.includes(verdict)) return escalate('the reviewer returned no accept, amend or escalate verdict')
  contradiction = contradictionOf(reply)
  const raw = Object.hasOwn(reply, 'reasons') && Array.isArray(reply.reasons) ? reply.reasons : []
  const reasons = raw.filter((r) => typeof r === 'string' && r.trim()).slice(0, MAX_REASONS).map((r) => clip(oneLine(r)))
  if (reasons.length === 0) return escalate(`the reviewer said ${verdict} but gave no reasons`)
  const known = new Set(knownIds)
  const refersTo = Object.hasOwn(reply, 'refers_to') && Array.isArray(reply.refers_to) ? [...new Set(reply.refers_to.filter((id) => known.has(id)))] : []
  let amendedDraft = null
  if (verdict === 'amend') {
    const draft = Object.hasOwn(reply, 'draft') ? reply.draft : null
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      return { ...escalate('the reviewer said amend but sent no edited draft'), refersTo }
    }
    // Held to the same checks as the ask itself. A split is checked as soft.
    const checked = validateAsk({ ...draft, kind: ask.kind === 'split' ? 'soft' : ask.kind, why: ask.why }, { repos })
    if (checked.refused) {
      return { ...escalate(`the edited draft's \`${checked.refused.field}\` ${checked.refused.message}`), refersTo }
    }
    const { title, repo, outcome, metric, guardrails } = checked.ask
    amendedDraft = { title, repo, outcome, metric, guardrails }
  }
  return { verdict, reasons, amendedDraft, refersTo, contradiction }
}

// POST /ask/review. Tests inject their own `review` instead.
export async function requestReview(body) {
  return farmFetch('/ask/review', body, { timeoutMs: REVIEW_FARM_MS })
}

// A farmd 503 means no run happened: the provider is not authenticated, or it
// hit a usage limit. "usage limited until <iso>" is recorded on the ledger.
function noteUnavailable(err, provider, model, nowMs) {
  const code = typeof err?.code === 'string' ? err.code : ''
  const limited = /^usage limited(?: until (\S+))?/.exec(code)
  if (limited) {
    const until = new Date(resetMs(limited[1], nowMs)).toISOString()
    store.markModelLimited(provider, model, until, 'ask review')
    return `${labelOf(provider)} (${model}) is usage-limited until ${formatResetTime(until)}`
  }
  return `${labelOf(provider)} is unavailable: ${clip(oneLine(err?.message || err))}`
}

// One ask. 'done' or 'failed' once a review ran, 'awaiting' when it must wait,
// 'skipped' when another sweep has it.
export async function reviewOne(ask, { now = Date.now, review = requestReview } = {}) {
  const item = store.getItem(ask.item_id)
  const draft = parseJson(ask.draft_json, {})
  const authorProvider = authorProviderOf(ask)
  const wait = (reason) => {
    const before = selectReview.get(ask.id)
    setWait.run(authorProvider, reason, ask.id)
    return before?.wait_reason === reason ? 'waiting' : 'awaiting'
  }
  const project = item?.project_id != null ? selectProject.get(item.project_id) : null
  const chosen = chooseReviewer({ authorProvider, projectSetting: project?.ask_review_provider ?? null })
  if (chosen.wait) return wait(chosen.wait)
  const { provider } = chosen
  const model = reviewerModel(provider)
  if (!model) return wait(`${labelOf(provider)} has no model to review on`)
  const available = providerAvailable(provider, model, now())
  if (available.wait) return wait(available.wait)

  const overlap = await askOverlap(ask, draft, item)
  const rules = servedRulesFor(project?.name ?? '', draft.repo)
  const input = buildReviewInput(ask, draft, { provider, model, project: project?.name, overlap, parent: parentOf(item), rules })
  if (input.refused) return wait(input.refused)
  // Read before the claim clears it: a 503 with the same reason is 'waiting'.
  const previousReason = selectReview.get(ask.id)?.wait_reason ?? null
  if (claim.run(authorProvider, provider, model, JSON.stringify(input.body), ask.id).changes !== 1) return 'skipped'

  let reply
  try {
    reply = await review(input.body)
  } catch (err) {
    if (err?.status === 503) {
      // The same reason as last time changes nothing anyone sees, so it does
      // not notify — otherwise each 503 would re-trigger the sweep at once.
      const reason = noteUnavailable(err, provider, model, now())
      release.run(reason, ask.id)
      return reason === previousReason ? 'waiting' : 'awaiting'
    }
    // A run may have started, so it is not retried: an ask gets one review.
    const why = clip(`the review failed: ${oneLine(err?.message || err)}`)
    finish.run('failed', 'escalate', JSON.stringify([why]), null, null, null, ask.id)
    return 'failed'
  }
  const repos = item?.project_id != null ? selectRepos.all(item.project_id).map((r) => r.repo) : []
  const knownIds = [...overlap.matches, ...overlap.candidates, ...overlap.abandoned].map((m) => m.id)
  const checked = checkVerdict(reply, { provider, repos, knownIds, ask })
  // The farm's fail-closed reply, or a reply from the wrong provider: no real
  // verdict came back.
  const usable = reply && typeof reply === 'object' && reply.unusable !== true && reply.provider === provider
  const status = usable ? 'done' : 'failed'
  finish.run(
    status,
    checked.verdict,
    JSON.stringify(checked.reasons),
    checked.amendedDraft ? JSON.stringify(checked.amendedDraft) : null,
    JSON.stringify(checked.refersTo),
    checked.contradiction ? JSON.stringify(checked.contradiction) : null,
    ask.id,
  )
  return status
}

let sweeping = false

// Exported for the tests; init() below is the only production caller. Never
// throws. `review` is injectable so a test can stand in for the farm.
export async function reviewAsks({ log, now = Date.now, review = requestReview } = {}) {
  const counts = { done: 0, failed: 0, awaiting: 0, waiting: 0, skipped: 0 }
  if (sweeping) return { ...counts, busy: true }
  sweeping = true
  try {
    insertMissing.run()
    for (const ask of selectAwaiting.all()) {
      try {
        counts[await reviewOne(ask, { now, review })]++
      } catch (err) {
        log?.error?.(`ask review: ask ${ask.id} could not be reviewed: ${oneLine(err?.message)}`)
      }
    }
  } catch (err) {
    log?.error?.(`ask review sweep failed: ${oneLine(err?.message)}`)
  } finally {
    sweeping = false
  }
  // 'waiting' (the same reason as last time) changes nothing anyone sees, so
  // it does not notify — otherwise the change would re-trigger this sweep.
  if (counts.done + counts.failed + counts.awaiting > 0) {
    try {
      store.notifyChange()
    } catch (err) {
      log?.error?.(`ask review: change notification failed: ${oneLine(err?.message)}`)
    }
  }
  return counts
}

// Boot only. A review left 'running' died mid-way. It is never re-run — the
// one run may already have happened — so it is closed as 'interrupted'.
export function failInterruptedReviews() {
  const rows = db.prepare("SELECT ask_id FROM ask_review WHERE status = 'running'").all()
  db.transaction(() => {
    for (const { ask_id } of rows) {
      finish.run('interrupted', 'escalate', JSON.stringify(['the review was interrupted by a restart']), null, null, null, ask_id)
    }
  })()
  return rows.length
}

// Same shape as caretakerRuling.init: change signals coalesced onto the next
// turn, plus a 60s re-sweep for reviews waiting on a provider. Started from
// server.js only, so no test server reaches farmd. Returns stop() for tests.
export function init(log, opts = {}) {
  const interrupted = failInterruptedReviews()
  if (interrupted > 0) log?.warn?.(`ask review: ${interrupted} review(s) were mid-way at shutdown — not retried`)
  const run = () => reviewAsks({ log, ...opts })
  let scheduled = false
  const unsubscribe = store.onChange(() => {
    if (scheduled) return
    scheduled = true
    setImmediate(() => {
      scheduled = false
      run()
    })
  })
  run()
  const timer = setInterval(run, RESWEEP_MS)
  timer.unref?.()
  return {
    stop() {
      unsubscribe()
      clearInterval(timer)
    },
  }
}
