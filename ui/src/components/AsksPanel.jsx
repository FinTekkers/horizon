// HZ-728: the item's open asks (item.asks, newest first, from
// server/src/asks.js). HZ-730: this is now the quiet "Suggested follow-ups"
// panel — soft asks as compact AskCards the owner can file or dismiss. A
// blocking ask shows in BlockingAsksBanner instead, and a PM split stays a
// read-only row: it is filed at its own gate. Agent-written text renders as
// plain React text, never as HTML or Markdown.

import AskCard from './AskCard'

export default function AsksPanel({ item }) {
  const asks = (item.asks || []).filter((a) => a.kind !== 'blocking')
  if (asks.length === 0) return null
  return (
    <section className="asks-panel" aria-label="Suggested follow-ups" data-testid="asks-panel">
      <div className="asks-panel__label">Suggested follow-ups</div>
      <ul className="asks-panel__list">
        {asks.map((ask) =>
          ask.kind === 'soft' ? (
            <li key={ask.id} className="asks-panel__ask" data-testid="ask-row">
              <AskCard item={item} ask={ask} compact />
            </li>
          ) : (
            <li key={ask.id} className="asks-panel__ask asks-panel__ask--split" data-testid="ask-row">
              <span className="asks-panel__kind">Split · filed at its gate</span> <span className="asks-panel__title">{ask.title}</span>
              <div className="asks-panel__why">
                <span className="asks-panel__step">{ask.step}:</span> {ask.why}
              </div>
            </li>
          ),
        )}
      </ul>
    </section>
  )
}
