// HZ-946: the Implement card's check line — each command of the final main
// check round (stepOutputs[implement].checks: [{ command, outcome, exit,
// noReport }], server/src/checkLine.js), its pass or fail, and "no per-test
// results" when it wrote no per-test report. Every state is text, never color
// alone, so it reads on a phone.

export const NO_PER_TEST_RESULTS = 'no per-test results'

export default function CheckLine({ checks }) {
  if (!checks?.length) return null
  return (
    <ul className="check-line" data-testid="check-line" aria-label="Check commands">
      {checks.map((c) => (
        <li key={c.command} className="check-line__row" data-testid="check-line-row">
          <span className={`check-line__outcome check-line__outcome--${c.outcome === 'fail' ? 'fail' : 'pass'}`}>
            {c.outcome === 'fail' ? 'fail' : 'pass'}
          </span>
          <code className="check-line__command">{c.command}</code>
          {c.outcome === 'fail' && c.exit != null && <span className="check-line__exit">exit {c.exit}</span>}
          {c.noReport && <span className="check-line__no-report">{NO_PER_TEST_RESULTS}</span>}
        </li>
      ))}
    </ul>
  )
}
