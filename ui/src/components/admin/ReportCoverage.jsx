import { useEffect, useState } from 'react'
import { getTestHistory } from '../../api'
import { NO_PER_TEST_RESULTS } from '../CheckLine'

// HZ-946: one repo's report coverage — each check command main's runs ran in
// the stored window (GET /api/admin/test-history's `commands`), with "no per-
// test results" when one of those runs wrote no per-test report. The endpoint
// is the owner's only: anyone else gets 403 or 404, and sees no section.
export function ReportCoverage({ repo }) {
  const [state, setState] = useState({ commands: null, error: null, hidden: false })

  useEffect(() => {
    let live = true
    setState({ commands: null, error: null, hidden: false })
    getTestHistory(repo).then(
      (history) => live && setState({ commands: history.commands ?? [], error: null, hidden: false }),
      (err) => {
        if (!live) return
        if (err.status === 403 || err.status === 404) setState({ commands: null, error: null, hidden: true })
        else setState({ commands: null, error: err.message, hidden: false })
      },
    )
    return () => {
      live = false
    }
  }, [repo])

  if (state.hidden) return null
  return (
    <section className="report-coverage" aria-label="Test report coverage" data-testid="report-coverage">
      <h4 className="report-coverage__title">Test report coverage</h4>
      {state.error && <div className="gh-error">Report coverage unavailable: {state.error}</div>}
      {!state.error && state.commands === null && <div className="report-coverage__note">Loading…</div>}
      {state.commands?.length === 0 && (
        <div className="report-coverage__note">No check runs stored for this repo in the last 90 days.</div>
      )}
      {state.commands?.length > 0 && (
        <ul className="report-coverage__list">
          {state.commands.map((c) => (
            <li key={c.command} className="report-coverage__row" data-testid="report-coverage-row">
              <code className="report-coverage__command">{c.command}</code>
              <span className="report-coverage__runs">
                {c.runs} {c.runs === 1 ? 'run' : 'runs'}
              </span>
              {c.no_report_runs > 0 && <span className="check-line__no-report">{NO_PER_TEST_RESULTS}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
