import { useRef, useState } from 'react'
import { getVerifyReport } from '../../api'

const MAX_N = 500
const DEFAULT_N = '50'
const DEFAULT_DAYS_BACK = 14

const VERDICT_ROWS = [
  ['pass', 'Pass'],
  ['work_failed', 'Work failed'],
  ['done_proof_incomplete', 'Done, proof incomplete'],
  ['none', 'No verdict'],
]
const CAUSE_ROWS = [
  ['prereq', 'Execute cause: prereq'],
  ['unforeseeable', 'Execute cause: unforeseeable'],
]

const daysAgoUtc = (days) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

// A whole number from 1 to MAX_N, or null.
function parseN(value) {
  if (!/^\d+$/.test(value)) return null
  const n = Number(value)
  return n >= 1 && n <= MAX_N ? n : null
}

// A 0-1 share as a percentage to 1 place; null (or anything not a number) is '—'.
const percent = (share) => (typeof share === 'number' && Number.isFinite(share) ? `${(share * 100).toFixed(1)}%` : '—')
const count = (group, key) => (group && Object.hasOwn(group, key) && typeof group[key] === 'number' ? group[key] : 0)

// HO-848: Delivery › Verify report — HO-841's GET /api/admin/productivity/verify
// behind a start date and N, so an owner needs no hand-made API call. It shows
// the totals, prereqShare and firstPassYield only: enums and numbers, never
// the per-Task list or any summary text. Nothing is read until Show.
export function VerifyReportSection() {
  const [since, setSince] = useState(() => daysAgoUtc(DEFAULT_DAYS_BACK))
  const [nText, setNText] = useState(DEFAULT_N)
  const [state, setState] = useState({ loading: false, error: null, data: null })
  // Only the newest request's answer is shown.
  const latest = useRef(0)

  const n = parseN(nText)
  const canShow = !!since && n !== null && !state.loading

  const submit = async (e) => {
    e.preventDefault()
    if (!canShow) return
    const request = ++latest.current
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const data = await getVerifyReport({ since, n })
      if (request === latest.current) setState({ loading: false, error: null, data })
    } catch (err) {
      if (request === latest.current) setState({ loading: false, error: err?.message || 'Could not load the report.', data: null })
    }
  }

  const data = state.data
  const verdicts = data?.totals?.verdicts
  const causes = data?.totals?.executeCauses

  return (
    <div className="panel admin__panel">
      <h2 className="panel__title admin__panel-title">Verify report</h2>
      <div className="panel__subtitle">
        Verify &amp; report outcomes and Execute causes for the first N Tasks closed after a start date (UTC), with
        the share of Execute failures caused by a prerequisite and the first-pass yield over the same Tasks.
      </div>

      <form className="verify-report__form" onSubmit={submit}>
        <label className="field">
          <span className="field__label">Start date</span>
          <input
            className="field__input"
            type="date"
            required
            value={since}
            onChange={(e) => setSince(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">Number of Tasks</span>
          <input
            className="field__input"
            type="number"
            min={1}
            max={MAX_N}
            step={1}
            required
            value={nText}
            onChange={(e) => setNText(e.target.value)}
          />
        </label>
        <button className="composer__submit" type="submit" disabled={!canShow}>
          Show
        </button>
      </form>
      {nText !== '' && n === null && <div className="gh-note">Number of Tasks must be a whole number from 1 to {MAX_N}.</div>}

      {state.loading && (
        <div className="gh-note" role="status">
          Loading…
        </div>
      )}
      {state.error && (
        <div className="gh-error" role="alert">
          {state.error}
        </div>
      )}

      {data && !state.loading && (
        <div className="verify-report__result">
          <div className="gh-note" data-testid="verify-report-cohort">
            {data.returned > 0
              ? `${data.returned} of up to ${data.n} Tasks closed after ${data.since}`
              : `No Tasks closed after ${data.since}`}
            {' · '}
            {data.project === 'all' ? 'all projects' : `project ${data.project}`}
          </div>
          <div className="data-table-wrap">
            <table className="data-table" aria-label="Verify report totals">
              <tbody>
                {VERDICT_ROWS.map(([key, label]) => (
                  <tr key={key}>
                    <th align="left" scope="row">
                      {label}
                    </th>
                    <td>{count(verdicts, key)}</td>
                  </tr>
                ))}
                {CAUSE_ROWS.map(([key, label]) => (
                  <tr key={key}>
                    <th align="left" scope="row">
                      {label}
                    </th>
                    <td>{count(causes, key)}</td>
                  </tr>
                ))}
                <tr>
                  <th align="left" scope="row">
                    Prereq share
                  </th>
                  <td data-testid="verify-report-prereq-share">{percent(data.prereqShare)}</td>
                </tr>
                <tr>
                  <th align="left" scope="row">
                    First-pass yield
                  </th>
                  <td data-testid="verify-report-first-pass-yield">{percent(data.firstPassYield)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
