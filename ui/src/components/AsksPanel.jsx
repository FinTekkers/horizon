// HZ-728: the item's open asks — follow-up and prerequisite items a step
// drafted (item.asks, newest first, from server/src/asks.js), plus a PM split
// as kind "split". Read-only: nothing here files, dismisses or edits an ask.
// Agent-written text renders as plain React text, never as HTML or Markdown.

const KIND_LABELS = { blocking: 'Blocking', soft: 'Soft', split: 'Split' }

export default function AsksPanel({ item }) {
  const asks = item.asks || []
  if (asks.length === 0) return null
  return (
    <section className="asks-panel" aria-label="Asks" data-testid="asks-panel">
      <div className="asks-panel__label">Asks · not filed</div>
      <ul className="asks-panel__list">
        {asks.map((ask) => (
          <li key={ask.id} className="asks-panel__ask" data-testid="ask-row">
            <span className={`asks-panel__kind asks-panel__kind--${ask.kind}`}>{KIND_LABELS[ask.kind] || ask.kind}</span>{' '}
            <span className="asks-panel__title">{ask.title}</span>
            <div className="asks-panel__why">
              <span className="asks-panel__step">{ask.step}:</span> {ask.why}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
