// Lifecycle PRESENTATION tokens. The model itself is not here.
//
// HZ-128: the step table and every derived helper (STEPS, PHASES,
// requiredStepIndex, isClosed, curStep, phaseIdx, awaitingGate, stepStatus,
// phaseStepIndexes, reworkTargets, defaultReworkTarget, …) live in
// domain/js/lifecycle.js, generated from domain/steps.json. Before that, this
// file and server/src/lifecycle.js each carried their own copy — isClosed and
// curStep byte-for-byte identical, and the index lookup differing only in name
// and argument order. Import the model from domain/, never from here.
//
// What stays: theme-aware colour tokens, which domain/ must never carry.
// AGENTS moved one file over to ./agentTokens.js so the server's hex map and
// this themed map are named identically on both sides.

export const PHASE_ACCENT = ['var(--primary-ink)', 'var(--architect-ink)', 'var(--success-ink)', 'var(--danger-ink)', 'var(--warning-ink)']
export const PHASE_ACCENT_BG = ['var(--primary-bg)', 'var(--accent-bg)', 'var(--success-bg)', 'var(--danger-bg)', 'var(--warning-bg)']

export const PRIORITY_COLORS = {
  Critical: 'var(--danger-ink)',
  High: 'var(--warning-ink)',
  Medium: 'var(--primary-ink)',
  Low: 'var(--muted)',
}

export function priorityColor(priority) {
  return PRIORITY_COLORS[priority] || 'var(--muted)'
}
