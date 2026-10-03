// WhatsApp gate-approval origin check (HZ-140).
//
// The approve-via-whatsapp route used to be guarded by FARM_SHARED_SECRET —
// which farm/tmux_mgr.py forwarded into every agent session — and it trusted
// whatever `sender` string the caller put in the body. Both halves of that
// were forgeable by any agent with Bash. This module is the replacement:
//
//   1. a dedicated credential (WA_APPROVAL_SECRET), which no step or PM
//      agent session ever receives, and
//   2. a server-held approver allowlist, so the sender is proved *here*
//      rather than farm-side where the caller could simply skip the check.
//
// Deny-by-default throughout, exactly like loginAllowlist.js: an empty or
// unset WA_APPROVER_JIDS means NO sender is allowed, never "allow all", and
// an unset WA_APPROVAL_SECRET means no approval is accepted at all.
//
// normalizeJid mirrors farm/concierge_agent.py's normalize_jid by hand. That
// duplication is deliberate: domain/ is the lifecycle-step model and nothing
// else (see domain/README.md), so a jid parser does not belong there, and
// farm/ is Python that Node cannot import. What keeps the two from drifting
// is a single shared vector file — farm/tests/fixtures/wa_jid_vectors.json —
// which both test suites load.

import crypto from 'node:crypto'
import { WA_APPROVAL_SECRET, WA_APPROVER_JIDS } from './config.js'

// '15551112222:12@s.whatsapp.net' -> '15551112222'. The device suffix and
// the server part are routing detail, not identity.
export function normalizeJid(jid) {
  if (typeof jid !== 'string') return ''
  return jid.split('@')[0].split(':')[0].trim().toLowerCase()
}

// Where a bare number is routed. WhatsApp's own server part for an individual
// chat; a group would be '@g.us', which an operator must spell out (see
// canonicalJid) because the approver list is individuals by design — HZ-141
// deliberately added no group recipient setting.
const DEFAULT_SERVER = 's.whatsapp.net'

// '15551112222' and '15551112222:7@s.whatsapp.net' both ->
// '15551112222@s.whatsapp.net'.
//
// normalizeJid answers "who is this", which is all the allowlist needs. A
// RECIPIENT needs more than that: the bridge routes on a full jid, so a bare
// number — which is the form DEPLOY.md documents and farm/config.py's own
// example uses — cannot be posted as-is, and a device suffix addresses one
// specific phone rather than the person. This is the one function that turns a
// configured entry into something sendable, so every configured form that the
// allowlist accepts is also deliverable.
//
// An explicit server part is KEPT rather than forced to the default, so an
// operator who does spell out '@g.us' gets what they wrote instead of a silently
// rewritten address that routes somewhere else.
export function canonicalJid(entry) {
  const user = normalizeJid(entry)
  if (!user) return ''
  const server = typeof entry === 'string' && entry.includes('@') ? entry.split('@').pop().trim().toLowerCase() : ''
  return `${user}@${server || DEFAULT_SERVER}`
}

const ALLOWED_APPROVERS = new Set(WA_APPROVER_JIDS.map(normalizeJid).filter(Boolean))

export function isAllowedApprover(jid) {
  const normalized = normalizeJid(jid)
  return normalized !== '' && ALLOWED_APPROVERS.has(normalized)
}

// The same list, as recipients — HZ-141's gate-arrival notifier needs to send
// TO the approvers, not just check a jid against them. Deliberately one export
// away from isAllowedApprover rather than a second setting: whoever can approve
// a gate is exactly whoever is told one is waiting, and a parallel notify list
// would eventually mean messaging someone whose approval is then refused.
//
// Returns CANONICAL jids, not the raw entries: one setting must not mean two
// formats. WA_APPROVER_JIDS is documented as approver *numbers*, and a bare
// number approves a gate fine (isAllowedApprover normalizes both sides) but is
// not a routable recipient — posting it to the bridge would fail every attempt
// and give up silently a couple of hours later, on a configuration the runbook
// calls valid. canonicalJid closes that gap in the one direction it exists.
//
// De-duplicated, because two entries for the same person ('155…' and
// '155…:7@s.whatsapp.net') are one human and must produce one message per
// arrival, not two.
//
// Empty stays empty — deny-all above means notify-nobody here, not notify-all.
export function approverJids() {
  return [...new Set(WA_APPROVER_JIDS.map(canonicalJid).filter(Boolean))]
}

// "The owner" (operator ruling, 2026-10-02): the first WA_APPROVER_JIDS entry,
// as a sendable jid. The one definition — the caretaker pings this jid and the
// WhatsApp kill switch (HZ-274) accepts only this sender. null when unset.
export function ownerJid() {
  const first = WA_APPROVER_JIDS[0]
  return first ? canonicalJid(first) || null : null
}

// Compared like isAllowedApprover, on the user part only, so any jid form the
// concierge lets through ('…@s.whatsapp.net', a device suffix) is the owner
// when its number is.
export function isOwner(jid) {
  const owner = normalizeJid(ownerJid() ?? '')
  return owner !== '' && normalizeJid(jid) === owner
}

export function approvalSecretConfigured() {
  return typeof WA_APPROVAL_SECRET === 'string' && WA_APPROVAL_SECRET.length > 0
}

// Compares SHA-256 digests rather than the raw strings: timingSafeEqual
// throws on unequal buffer lengths, so a header of the wrong length would
// otherwise crash the route with a 500 instead of answering 401 — and the
// length of a rejected guess is itself a hint worth not leaking.
export function approvalSecretOk(header) {
  if (!approvalSecretConfigured()) return false
  if (typeof header !== 'string' || header.length === 0) return false
  const supplied = crypto.createHash('sha256').update(header).digest()
  const expected = crypto.createHash('sha256').update(WA_APPROVAL_SECRET).digest()
  return crypto.timingSafeEqual(supplied, expected)
}
