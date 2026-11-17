// HO-875: the text every Tracker adapter writes the same way — moved out of
// github.js unchanged so the sl adapter (backends/slTracker.js) shares one
// copy instead of a duplicate that could drift. A leaf: it imports nothing.

// Every comment Horizon posts carries this marker in its footer, so comment
// ingestion (GitHub's and sl's) can skip Horizon's own text.
export const HORIZON_FOOTER = 'posted by Horizon_'

// An item's body in Horizon's section format. Inverse of parseIssueBody in
// store.js.
export function composeIssueBody({ outcome, metric, guardrails }) {
  return [
    '## Outcome',
    outcome.trim(),
    '',
    '## Success metric',
    metric.trim(),
    '',
    '## Guardrails',
    guardrails?.trim() || '_Defaults apply (tests, linters, e2e must pass)._',
  ].join('\n')
}
