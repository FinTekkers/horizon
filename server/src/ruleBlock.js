// HZ-346: an implement run that stopped on a rule with no code changes.
//
// The agent writes `rule` and `needs`, so both are untrusted. The board shows
// them as React text; the owner's WhatsApp ping shows them through plainText()
// below, which strips WhatsApp markup and defangs anything WhatsApp would turn
// into a live link. The only link in the ping is Horizon's own item link.
//
// The ping rides the gate_notice outbox (waPollVotes.js queues its acks there
// too), so gateNotifier.js's drainOutbox sends it with its retries. This module
// does not import gateNotifier.js: no lifecycle path does. One block is one
// row, queued in the transaction that records the block, and a run is blocked
// at most once — so a re-poll or a repeat report has nothing to send again.

import { db } from './db.js'
import { UI_URL } from './config.js'
import { ownerJid } from './waApprovers.js'

// The same caps farm/step_agent.py applies before sending a report.
export const RULE_MAX_CHARS = 300
export const NEEDS_MAX_CHARS = 600

const TITLE_MAX_CHARS = 200

// One line of plain text, at most `max` characters: no control characters,
// no WhatsApp markup (*bold*, _italic_, ~strike~, `code`), and nothing
// WhatsApp would linkify — `://` and a dot before a domain-like word are
// bracketed, so `https://evil.example` reads `https[:]//evil[.]example`.
export function plainText(value, max) {
  const text = String(value ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[*_~`]/g, '')
    .replace(/:\/\//g, '[:]//')
    .replace(/([\p{L}\p{N}])\.(?=\p{L}{2})/gu, '$1[.]')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function renderRuleBlockPing(item, block) {
  const link = `${UI_URL}/${String(item.id).toLowerCase()}`
  return [
    `${item.id} — ${plainText(item.title, TITLE_MAX_CHARS)}`,
    'Blocked by a rule: the agent stopped without changing any code.',
    `Rule: "${plainText(block.rule, RULE_MAX_CHARS)}"`,
    `Needs: ${plainText(block.needs, NEEDS_MAX_CHARS)}`,
    'Add a dependency on the item that delivers it, resume to retry, or abandon.',
    link,
  ].join('\n')
}

// Queues the owner's one ping for this block. Returns the rows queued: 0 when
// no owner is configured (deny-all means notify nobody, as at a gate).
export function enqueueRuleBlockPing(item, block, { owner = ownerJid } = {}) {
  const recipient = owner()
  if (!recipient) return 0
  return db
    .prepare('INSERT INTO gate_notice (item_id, step_index, recipient, body) VALUES (?, ?, ?, ?)')
    .run(item.id, item.cursor, recipient, renderRuleBlockPing(item, block)).changes
}

// work_item.rule_block_json -> {rule, needs, runId, blockedAt}, or null.
export function parseRuleBlock(json) {
  if (typeof json !== 'string' || json === '') return null
  try {
    const block = JSON.parse(json)
    if (!block || typeof block.rule !== 'string' || typeof block.needs !== 'string') return null
    return { rule: block.rule, needs: block.needs, runId: block.runId ?? null, blockedAt: block.blockedAt ?? null }
  } catch {
    return null
  }
}
