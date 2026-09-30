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
// Returns the RAW configured entries, not the normalized set: a normalized jid
// has lost its server part ('@s.whatsapp.net'), which the bridge needs to route.
// Empty stays empty — deny-all above means notify-nobody here, not notify-all.
export function approverJids() {
  return [...WA_APPROVER_JIDS]
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
