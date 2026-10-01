// Lifecycle PRESENTATION tokens. The model itself is not here.
//
// HZ-128: the step table and every derived helper (STEPS, PHASES,
// requiredStepIndex, isClosed, curStep, phaseIdx, awaitingGate, stepStatus,
// phaseStepIndexes, reworkTargets, defaultReworkTarget, …) live in
// domain/js/lifecycle.js, which reads domain/steps.json. Before that, this
// file and server/src/lifecycle.js each carried their own copy — isClosed and
// curStep byte-for-byte identical, and the index lookup differing only in name
// and argument order. Import the model from domain/, never from here.
//
// What stays: theme-aware colour tokens, which domain/ must never carry.
// AGENTS moved one file over to ./agentTokens.js so the server's hex map and
// this themed map are named identically on both sides.

import { PRIORITY } from '../../../domain/js/priorities.js'

export const PHASE_ACCENT = ['var(--primary-ink)', 'var(--architect-ink)', 'var(--success-ink)', 'var(--danger-ink)', 'var(--warning-ink)']
export const PHASE_ACCENT_BG = ['var(--primary-bg)', 'var(--accent-bg)', 'var(--success-bg)', 'var(--danger-bg)', 'var(--warning-bg)']

// HZ-135: the theme tokens stay here — colour is presentation and domain/ must
// never carry it — but the KEYS are PRIORITY's rather than a fifth hand-typed
// copy of the vocabulary. Keyed by named constant, not by array position, so a
// reordered domain/priorities.json cannot silently recolour the board.
// server/test/domain-priority-pins.test.mjs pins this map to the exact tokens it
// carried before HZ-135 and asserts every declared priority has one.
export const PRIORITY_COLORS = {
  [PRIORITY.CRITICAL]: 'var(--danger-ink)',
  [PRIORITY.HIGH]: 'var(--warning-ink)',
  [PRIORITY.MEDIUM]: 'var(--primary-ink)',
  [PRIORITY.LOW]: 'var(--muted)',
}

export function priorityColor(priority) {
  return PRIORITY_COLORS[priority] || 'var(--muted)'
}
