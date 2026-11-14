// HO-845: the patched command's three checks — contract audit, preflight and
// rehearsal, in the order they run — from item.runPlan.patchedCommand
// ({ index, stages: [{ stage, status, reason }], failedStage, findings,
// approvable }). Shown on the Approve the run card while they run, and on
// Run plan once one failed. Names and reason ids only, rendered as text.

export const COMMAND_CHECK_LABELS = Object.freeze({ audit: 'contract audit', preflight: 'preflight', rehearsal: 'rehearsal' })
const STATUS = {
  pass: { glyph: '✓', text: 'passed' },
  fail: { glyph: '✕', text: 'failed' },
  pending: { glyph: '…', text: 'running' },
  not_started: { glyph: '·', text: 'waits for the check before it' },
}

export default function CommandChecksStatus({ checks }) {
  if (!checks) return null
  const failed = checks.failedStage ? COMMAND_CHECK_LABELS[checks.failedStage] ?? checks.failedStage : null
  return (
    <div className="step-card__preflight" data-testid="command-checks">
      <div>Checks for command {checks.index + 1}:</div>
      <ul className="step-card__preflight-unmet">
        {checks.stages.map((s) => {
          const status = STATUS[s.status] ?? STATUS.not_started
          return (
            <li key={s.stage} data-testid={`command-check-${s.stage}`}>
              {status.glyph} {COMMAND_CHECK_LABELS[s.stage] ?? s.stage} — {status.text}
              {s.status === 'fail' && s.reason ? ` (${s.reason})` : ''}
            </li>
          )
        })}
      </ul>
      {failed && (
        <div className="step-card__run-plan-warning" data-testid="command-check-failed" style={{ color: 'var(--danger-ink)' }}>
          <div>Failed check: {failed}</div>
          {checks.findings?.length > 0 && (
            <ul className="step-card__preflight-unmet">
              {checks.findings.map((finding, i) => (
                <li key={`${finding}:${i}`} data-testid="command-check-finding">
                  {finding}
                </li>
              ))}
            </ul>
          )}
          <div>No Approve card for command {checks.index + 1}; every other command keeps its approval.</div>
        </div>
      )}
      {!failed && !checks.approvable && (
        <div style={{ color: 'var(--muted)' }} data-testid="command-checks-waiting">
          Approve waits until all three checks pass.
        </div>
      )}
    </div>
  )
}
