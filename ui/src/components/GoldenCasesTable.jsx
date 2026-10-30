// HZ-541: an item's golden cases on its first gate — the server's
// item.goldenCases. One row per case: inputs, measure, expected value,
// tolerance and source. A source the knowledge index holds links to its
// document and names the section; one it does not is a red error, and the set
// cannot be approved. Each row links to the metric line that names the set.
// One button approves the whole set (v1 has no per-case approve). Every value
// renders as React text: the cases are agent output, so no raw HTML.

const show = (value) => (typeof value === 'string' ? value : JSON.stringify(value))

function inputsText(inputs) {
  const entries = Object.entries(inputs ?? {})
  return entries.length ? entries.map(([key, value]) => `${key} = ${show(value)}`).join(', ') : '—'
}

function toleranceText({ abs, rel } = {}) {
  const parts = []
  if (abs !== undefined) parts.push(`± ${abs}`)
  if (rel !== undefined) parts.push(`± ${+(rel * 100).toPrecision(6)}%`)
  return parts.join(' or ') || '—'
}

function Source({ c }) {
  if (!c.sourceIndexed) {
    return (
      <span className="golden-cases__source-error" data-testid="golden-source-error">
        {c.source} — not in the knowledge index
      </span>
    )
  }
  return (
    <>
      <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer">
        <code className="data-table__ref">{c.source}</code>
      </a>
      <div className="golden-cases__section">
        {c.sourceTitle}
        {c.sourcePage ? ` · p. ${c.sourcePage}` : ''}
      </div>
    </>
  )
}

export default function GoldenCasesTable({ goldenCases, onApproveAll = null, busy = false }) {
  const { cases, errors, approved, approvedBy, metricLine } = goldenCases
  const count = cases.length
  return (
    <div className="golden-cases" data-testid="golden-cases">
      <div className="golden-cases__title">
        Golden cases · {count} case{count === 1 ? '' : 's'}
        {approved ? ` · approved by ${approvedBy}` : ''}
      </div>
      {count > 0 && (
        <div className="data-table-wrap">
          <table className="data-table" aria-label="Golden cases">
            <thead>
              <tr>
                <th scope="col">Case</th>
                <th scope="col">Inputs</th>
                <th scope="col">Measure</th>
                <th scope="col">Expected</th>
                <th scope="col">Tolerance</th>
                <th scope="col">Source</th>
                <th scope="col">Metric</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id}>
                  <td>
                    <code className="data-table__ref">{c.id}</code>
                  </td>
                  <td>{inputsText(c.inputs)}</td>
                  <td>{c.measure}</td>
                  <td>{show(c.expected)}</td>
                  <td>{toleranceText(c.tolerance)}</td>
                  <td>
                    <Source c={c} />
                  </td>
                  <td>{metricLine ? <a href={`#metric-line-${metricLine}`}>Metric line {metricLine}</a> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {errors.length > 0 && (
        <ul className="golden-cases__errors" role="alert">
          {errors.map((error, i) => (
            <li key={i}>{error}</li>
          ))}
        </ul>
      )}
      {count === 0 && errors.length === 0 && <div className="golden-cases__empty">The golden-cases sub-step has written no cases yet.</div>}
      {!approved && onApproveAll && (
        <button className="btn-gate-approve" disabled={busy || count === 0 || errors.length > 0} aria-busy={busy || undefined} onClick={onApproveAll}>
          Approve all {count} case{count === 1 ? '' : 's'}
        </button>
      )}
    </div>
  )
}
