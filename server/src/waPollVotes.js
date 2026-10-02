// WhatsApp gate-approval poll votes (HZ-142).
//
// Approving from WhatsApp used to mean typing at the concierge and having a
// model interpret it, which produced false "processing that approval now"
// replies and wiped pending offers. This module is the replacement for the
// approval half of that: a tap on a native poll, resolved here, deterministically.
//
// GUARDRAIL 1 IS STRUCTURAL, NOT CAREFUL. This module imports db, store,
// config, waApprovers and domain/js/lifecycle.js — no orchestrator, no
// personas, no definitions, nothing under farm/. There is no model to call on
// this path because nothing on this path can reach one. The two actions a vote
// can take are INJECTED by app.js rather than imported, which is what keeps
// that true even though app.js itself legitimately imports the orchestrator.
// server/test/wa-poll-no-model.test.mjs walks the transitive import graph and
// fails if that changes. Same shape as gateNotifier.js's own promise.
//
// FOUR CHECKS, ALL BEFORE ANY WRITE, then an atomic claim:
//
//   1. the voter is on the server-held allowlist        (guardrail 2)
//   2. the poll is one this server sent, and is current (guardrail 3)
//   3. the item is STILL at that gate                   (guardrail 3)
//      ...and its project is still enabled               (HZ-209)
//   4. this arrival at the gate is not already decided
//
// Checks 2 and 4 are arrival-scoped on purpose. The obvious implementation of
// "already decided" — look for a gate_decision row at (item, step) — is wrong:
// store.requestChanges() writes a 'rejected' gate_decision row and never
// deletes it, so after one send back every future poll on that gate would be
// refused forever. gate_poll.decided_at and gate_poll.superseded_at are scoped
// to one arrival, so a re-arrival gets a fresh poll that genuinely works.

import { db } from './db.js'
import * as store from './store.js'
import { isClosed, isAbandoned } from '../../domain/js/lifecycle.js'
import { isAllowedApprover, normalizeJid } from './waApprovers.js'
import { POLL_APPROVE, POLL_SEND_BACK, POLL_OPTIONS } from './waSend.js'

// What a vote resolved to, and the HTTP status app.js answers with. Every
// 4xx is FINAL — the bridge retries 5xx and network failures only, so a
// refused vote must never come back, or one unauthorised tap would hammer
// this route forever.
export const OUTCOMES = {
  applied: 200,
  duplicate: 200,
  ignored_not_allowed: 403,
  ignored_unknown_poll: 404,
  ignored_unknown_option: 422,
  ignored_superseded: 409,
  ignored_stale_gate: 409,
  ignored_already_decided: 409,
  ignored_project_disabled: 409,
  failed: 502,
}

// store.js's own refusals, as opposed to a merge or an issue-close that blew
// up downstream. Both come back as { error }, but only the second is a 502:
// 'closed' or 'project_not_active' is a conflict with the board's state, not a
// bad gateway, and the bridge treats 4xx as final either way.
const STORE_REFUSALS = new Set([
  'not_found',
  'not_at_gate',
  'stale_step',
  'project_not_active',
  'closed',
  'abandoned',
  'invalid_target',
])

const CHOICES = { [POLL_APPROVE]: 'approve', [POLL_SEND_BACK]: 'send_back' }

// Exact string equality against POLL_OPTIONS, never a fuzzy match. A guess
// here could approve a gate the human meant to send back, so an unrecognised
// option is refused rather than resolved to the nearest one.
export function choiceFor(selectedOption) {
  return Object.prototype.hasOwnProperty.call(CHOICES, selectedOption) ? CHOICES[selectedOption] : null
}

// ---- registration, called from gateNotifier.js's sweep ----

const insertPoll = db.prepare(
  'INSERT INTO gate_poll (item_id, step_index, recipient, question) VALUES (?, ?, ?, ?)',
)
const supersedeOpen = db.prepare(
  "UPDATE gate_poll SET superseded_at = datetime('now') WHERE item_id = ? AND superseded_at IS NULL",
)

// Retires every poll this item still has open. Called ONCE per arrival, by
// the sweep, before the new batch is registered.
//
// Scoped to the item, not to (item, step), because an item that has moved on
// has no live poll at all — leaving one tappable would let a stale tap decide
// a gate the human is no longer looking at.
//
// Called on EVERY fresh arrival, including when WA_POLL_ENABLED is off. That
// is not belt-and-braces: with polls disabled mid-flight, an item that is sent
// back and returns to the same gate would otherwise have arrival #1's poll
// still live and still matching the cursor, and it would decide arrival #2.
//
// Once per arrival rather than once per poll, because the several polls of one
// arrival — one per approver — must all stay live for each other.
export function supersedeOpenPolls(itemId) {
  return supersedeOpen.run(itemId).changes
}

// Returns the new gate_poll id. The caller runs this inside its own
// transaction alongside the notice rows and the notified_step write, so a
// crash between them cannot leave an arrival marked notified with no poll.
export function registerPoll({ itemId, stepIndex, recipient, question }) {
  return Number(insertPoll.run(itemId, stepIndex, recipient, question).lastInsertRowid)
}

// Called by the poll drain the moment the bridge confirms a send. Until this
// runs the poll is a tappable orphan — see gateNotifier.js's drainPolls.
export function attachPollMessageId(pollId, pollMsgId) {
  return db.prepare('UPDATE gate_poll SET poll_msg_id = ? WHERE id = ?').run(pollMsgId, pollId).changes === 1
}

// ---- the vote path ----

const selectPollByMsgId = db.prepare('SELECT * FROM gate_poll WHERE poll_msg_id = ?')
const selectVote = db.prepare('SELECT * FROM gate_poll_vote WHERE vote_id = ?')
const insertVote = db.prepare(
  'INSERT INTO gate_poll_vote (vote_id, poll_id, voter_jid, choice, outcome) VALUES (?, ?, ?, ?, ?)',
)
const setVoteOutcome = db.prepare('UPDATE gate_poll_vote SET outcome = ? WHERE vote_id = ?')
// Outcomes that did NOT decide the gate and left the claim released, so a
// later delivery of the same vote is allowed to finish the job rather than
// being answered as a duplicate.
const RETAKEABLE = new Set(['interrupted', 'failed'])
const retakeVote = db.prepare(
  "UPDATE gate_poll_vote SET outcome = 'claimed', poll_id = ?, choice = ? WHERE vote_id = ? AND outcome IN ('interrupted','failed')",
)
const claimPoll = db.prepare("UPDATE gate_poll SET decided_at = datetime('now') WHERE id = ? AND decided_at IS NULL")
const releasePoll = db.prepare('UPDATE gate_poll SET decided_at = NULL WHERE id = ?')

// Records the vote AND claims the poll in one transaction, so "the first valid
// vote decides" is a property of the database rather than of the order two
// requests happened to interleave in. Returns why it could not be claimed, or
// null when this caller won.
//
// Same conditional-claim pattern drainOutbox() uses on gate_notice: a
// WHERE-guarded UPDATE plus a changes === 1 check.
const claim = db.transaction((voteId, poll, voterJid, choice) => {
  const existing = selectVote.get(voteId)
  if (existing && RETAKEABLE.has(existing.outcome)) {
    // A vote whose action never landed — the process died between the claim
    // and the act, or the act itself failed. Either way the claim was
    // released and the cursor never moved, so the bridge retrying is exactly
    // right: this delivery finishes the job the last one did not.
    retakeVote.run(poll.id, choice, voteId)
  } else if (existing) {
    // Either already carried to completion, or a second delivery overlapping
    // the first one still in flight. Both are the same answer: decide once.
    return 'duplicate'
  } else {
    try {
      insertVote.run(voteId, poll.id, voterJid, choice, 'claimed')
    } catch (err) {
      // The primary key is the backstop for the read above — belt as well as
      // braces, since a collision here can only mean a duplicate.
      if (String(err?.code || '').includes('CONSTRAINT')) return 'duplicate'
      throw err
    }
  }
  if (claimPoll.run(poll.id).changes !== 1) {
    setVoteOutcome.run('ignored_already_decided', voteId)
    return 'ignored_already_decided'
  }
  return null
})

// The label an approval or a send-back is attributed to. Built from the PROVEN
// jid — the bridge sends no display name and one would be unprovable anyway.
function actorFor(voterJid) {
  return `...${normalizeJid(voterJid).slice(-4)} via WhatsApp poll`
}

function result(outcome, extra = {}) {
  return { outcome, status: OUTCOMES[outcome], ...extra }
}

const insertAck = db.prepare('INSERT INTO gate_notice (item_id, step_index, recipient, body) VALUES (?, ?, ?, ?)')

// Tells the voter their tap landed, by riding the text outbox that already
// exists — so the ack inherits its backoff, its attempt cap and its
// at-most-once discipline rather than reinventing them.
//
// ENQUEUED AFTER THE DECISION HAS COMMITTED, and wrapped, so a failure to
// acknowledge can never undo an approval. The worst case is a decided gate
// nobody was told about, which is strictly better than the reverse.
//
// The send-back line invites a follow-up in plain text. That reply is handled
// by the concierge's EXISTING `feedback` action — already on its two-entry
// whitelist — so there is no new code and no new path here. It is also not a
// breach of guardrail 1: the routing decision is already committed and
// nothing the human types afterwards can change it.
function enqueueAck(poll, choice, voterJid) {
  try {
    const body =
      choice === 'approve'
        ? `${poll.item_id} — approved from your poll. Thanks.`
        : `${poll.item_id} — sent back from your poll. Reply with any detail and I'll attach it as feedback.`
    insertAck.run(poll.item_id, poll.step_index, canonicalRecipient(poll, voterJid), body)
  } catch {
    // Deliberately swallowed. See above.
  }
}

// The poll's own recipient, which is already a canonical jid (approverJids()
// produced it). Falls back to the voter's jid only if the poll row somehow has
// none — a message to the person who tapped beats no message at all.
function canonicalRecipient(poll, voterJid) {
  return poll.recipient || voterJid
}

// The whole vote-to-decision path.
//
// `approve` and `sendBack` are injected by app.js:
//   approve(itemId, stepIndex, notes, actor) -> store.js-shaped result
//   sendBack(itemId, feedback, actor)        -> store.js-shaped result
// Injected, not imported, so this module cannot reach performGateApproval's
// module and therefore cannot reach the orchestrator. See the header.
//
// CLAIM THEN ACT, not one transaction: approve() awaits GitHub (a PR merge, an
// issue close), which cannot run inside a synchronous SQLite transaction. The
// claim is what makes the window safe; a failure afterwards releases it, so a
// merge that failed leaves the gate genuinely re-tappable.
export async function applyVote({ voteId, pollMsgId, voterJid, selectedOption }, { approve, sendBack }) {
  // A replay of a vote already carried to completion. Answered before the
  // allowlist check so the bridge's retry of an ACCEPTED vote is idempotent
  // rather than a 403 on the second delivery. 'claimed' and the RETAKEABLE
  // outcomes are deliberately NOT terminal — claim() below decides those.
  const seen = selectVote.get(voteId)
  if (seen && seen.outcome !== 'claimed' && !RETAKEABLE.has(seen.outcome)) {
    return result(seen.outcome === 'applied' ? 'duplicate' : seen.outcome, { replayOf: seen.outcome })
  }

  // 1. Guardrail 2. Deliberately first, and deliberately before any write: an
  //    unauthorised flood must not be able to grow gate_poll_vote without
  //    bound, and a rejected voter must get no oracle for which polls exist.
  if (!isAllowedApprover(voterJid)) return result('ignored_not_allowed')

  // 2. A poll this server actually sent, and the current one for its item.
  const poll = selectPollByMsgId.get(pollMsgId)
  if (!poll) return result('ignored_unknown_poll')
  if (poll.superseded_at) return result('ignored_superseded', { itemId: poll.item_id, stepIndex: poll.step_index })

  const choice = choiceFor(selectedOption)
  if (!choice) return result('ignored_unknown_option', { itemId: poll.item_id, stepIndex: poll.step_index })

  // 3. Guardrail 3. The cursor is the authority on where the item is now; a
  //    poll sent an hour ago says nothing about it. This is also what catches
  //    a gate already decided through the concierge's free-text path or
  //    through the browser — both move the cursor.
  const item = store.getItem(poll.item_id)
  const at = { itemId: poll.item_id, stepIndex: poll.step_index, choice }
  if (!item || item.cursor !== poll.step_index || isClosed(item) || isAbandoned(item)) {
    return result('ignored_stale_gate', at)
  }
  // HZ-209: checked when the vote is applied, not only when the poll went out
  // — a project disabled since then is never acted on. store.js refuses it
  // too (project_not_active); this catches it before the claim writes a row.
  if (!store.isProjectEnabled(item.project_id)) return result('ignored_project_disabled', at)

  // 4. First valid vote decides. Atomic.
  const refused = claim(voteId, poll, voterJid, choice)
  if (refused) return result(refused, at)

  let outcome = 'applied'
  let error = null
  try {
    const actor = actorFor(voterJid)
    const res =
      choice === 'approve'
        ? await approve(poll.item_id, poll.step_index, '', actor)
        : await sendBack(poll.item_id, '', actor)
    if (res?.error) {
      outcome = 'failed'
      error = res.error
    }
  } catch (err) {
    outcome = 'failed'
    error = String(err?.message || err)
  }
  setVoteOutcome.run(outcome, voteId)
  if (outcome === 'applied') enqueueAck(poll, choice, voterJid)
  if (outcome === 'failed') {
    // Release the claim: the gate did NOT move, so this arrival must stay
    // decidable. A store refusal ('closed', 'project_not_active') is a
    // conflict with the board's state and final; anything else is a merge or
    // an issue-close that blew up downstream, which is worth one more try.
    releasePoll.run(poll.id)
    return { ...result('failed', at), status: STORE_REFUSALS.has(error) ? 409 : 502, error }
  }
  return result('applied', at)
}

// A vote left 'claimed' when the process died is genuinely ambiguous: the
// approval may have committed before the crash. Mirrors
// gateNotifier.js's failInterruptedSends(), and resolves the ambiguity the
// safe way — the claim is released so a human can tap again, and the cursor
// check above is what stops that becoming a double approval if the first one
// did in fact land.
//
// Called once from gateNotifier.init(). Returns the number released.
export function releaseInterruptedVotes() {
  return db.transaction(() => {
    const stranded = db.prepare("SELECT vote_id, poll_id FROM gate_poll_vote WHERE outcome = 'claimed'").all()
    for (const row of stranded) {
      setVoteOutcome.run('interrupted', row.vote_id)
      if (row.poll_id != null) releasePoll.run(row.poll_id)
    }
    return stranded.length
  })()
}
