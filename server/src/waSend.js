// Outbound-only WhatsApp bridge client (HZ-141).
//
// The one place Node talks to the whatsapp-mcp bridge. A deliberate port of
// farm/whatsapp/mcp_bridge.py's BridgeTransport.send(), down to the failure
// taxonomy, because the notifier lives in Node (it needs the cursor, which is
// Node state) while the concierge's transport lives in Python. That is a second
// definition of BOT_MARKER and it is the one real cost of keeping this path in
// Node — bot-marker-parity.test.mjs fails the build if the two ever diverge.
//
// POST /api/send takes NO auth: it is a localhost-only endpoint. So there is no
// shared secret on this path at all — not FARM_SHARED_SECRET, and not HZ-140's
// WA_APPROVAL_SECRET, which belongs to the inbound approval route and is never
// read here.
//
// No retry lives in this module. It throws, and gateNotifier.js's drain owns
// the backoff, the attempt count and the give-up decision — one place that
// decides when to try again, rather than two nested ones.

import { WA_BRIDGE_URL } from './config.js'

// Must stay byte-equal to farm/whatsapp/mcp_bridge.py's BOT_MARKER. Prepended
// HERE and nowhere else: the bridge's inbound filter skips marker-prefixed text
// (mcp_bridge.py's fetch_new), which is what stops the concierge reacting to a
// notification, and a body that carried its own marker would double it.
export const BOT_MARKER = '\u{1F916} ' // robot face + space

export class WaSendError extends Error {
  // status: the HTTP status for a bridge-level refusal, or null when the
  // request never got an answer (network failure, timeout, abort). The drain
  // treats both identically — the distinction is for the log line a human reads.
  constructor(message, status = null) {
    super(message)
    this.name = 'WaSendError'
    this.status = status
  }
}

// Throws WaSendError on any non-success. `fetchImpl` and `timeoutMs` are
// injectable so tests can drive a real 500 through this function rather than
// stubbing it out and testing nothing.
export async function sendWhatsApp(recipient, text, { fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res
  try {
    res = await fetchImpl(`${WA_BRIDGE_URL}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient, message: BOT_MARKER + text }),
      signal: controller.signal,
    })
  } catch (err) {
    throw new WaSendError(`bridge send failed: ${err.message}`, null)
  } finally {
    clearTimeout(timer)
  }
  if (res.status !== 200) {
    const detail = await res.text().catch(() => '')
    throw new WaSendError(`bridge send returned ${res.status}: ${detail.slice(0, 200)}`, res.status)
  }
  // An unparseable body counts as success, exactly as the Python transport
  // does: the bridge has answered 200 and the message is most likely away, so
  // re-sending on a malformed body would risk a duplicate ping to a human to
  // fix nothing.
  let body
  try {
    body = await res.json()
  } catch {
    body = {}
  }
  if (body?.success === false) {
    throw new WaSendError(`bridge refused the send: ${body.message || 'unknown reason'}`, res.status)
  }
}

// The two poll options, byte-for-byte (HZ-142).
//
// These cross a process boundary twice: the bridge puts them in the
// PollCreationMessage, WhatsApp hashes them, the bridge resolves the hash back
// to a string, and waPollVotes.js matches that string against THIS array by
// exact equality. A normalisation difference anywhere on that loop — a dropped
// variation selector in '↩️', say — is a 422 on every tap and a poll that
// silently does nothing. So both ends pin the UTF-8 bytes in a test:
// infra/whatsapp-bridge/hzpoll/poll_test.go and
// server/test/gate-notifier-poll.test.mjs.
//
export const POLL_APPROVE = '✅ Approve' // white heavy check mark + space
export const POLL_SEND_BACK = '↩️ Send back' // arrow with hook + variation selector
export const POLL_OPTIONS = [POLL_APPROVE, POLL_SEND_BACK]

// Sends the gate poll and returns the bridge's poll message id — which is the
// only handle a later vote can be matched back to a gate by.
//
// THROWS when the bridge answers 200 with no messageId. That is the worst
// outcome available here: a poll is on the human's phone, tappable, and no row
// records it, so the tap resolves to nothing at all with no error anywhere.
// Failing loudly puts the row back on the retry path instead.
//
// Carries the BOT_MARKER, like sendWhatsApp. Probe 3 (infra/whatsapp-bridge/
// PROBE.md) established that the pinned bridge writes no `messages` row for a
// PollCreationMessage, so fetch_new() cannot see it and the marker is not
// strictly needed today — but that is a fact about upstream's
// extractTextContent, not a guarantee, and an upstream re-pin could undo it
// without anyone noticing. The cost is one 🤖 in the poll title, the same one
// already on every gate notification the human reads. The benefit is that the
// concierge can never react to a poll question even if the fact changes.
//
// No retry here either: the poll drain in gateNotifier.js owns the backoff,
// the attempt count and the give-up decision, exactly as it does for text.
export async function sendPoll(recipient, question, { fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res
  try {
    res = await fetchImpl(`${WA_BRIDGE_URL}/api/send-poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient, name: BOT_MARKER + question, options: POLL_OPTIONS }),
      signal: controller.signal,
    })
  } catch (err) {
    throw new WaSendError(`bridge poll send failed: ${err.message}`, null)
  } finally {
    clearTimeout(timer)
  }
  if (res.status !== 200) {
    const detail = await res.text().catch(() => '')
    throw new WaSendError(`bridge poll send returned ${res.status}: ${detail.slice(0, 200)}`, res.status)
  }
  let body
  try {
    body = await res.json()
  } catch {
    body = {}
  }
  if (body?.success === false) {
    throw new WaSendError(`bridge refused the poll: ${body.message || 'unknown reason'}`, res.status)
  }
  // Unlike sendWhatsApp, an unparseable or id-less body is NOT treated as
  // success. A text message that may or may not have arrived is worth not
  // duplicating; an untracked poll is worth nothing at all.
  const messageId = typeof body?.messageId === 'string' ? body.messageId.trim() : ''
  if (!messageId) {
    throw new WaSendError('bridge returned no poll messageId — the poll could not be tracked', res.status)
  }
  return messageId
}
