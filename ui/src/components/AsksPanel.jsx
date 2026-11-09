// HZ-728: the item's open asks (item.asks, newest first, from
// server/src/asks.js). HZ-730: this is now the quiet "Suggested follow-ups"
// panel — soft asks as compact AskCards the owner can file or dismiss. A
// blocking ask shows in BlockingAsksBanner instead, and a PM split stays a
// read-only row: it is filed at its own gate. Agent-written text renders as
// plain React text, never as HTML or Markdown.
//
// HZ-820: below them, "Closed with the item" — the soft asks Horizon dismissed
// when the item closed or was abandoned (item.parentClosedAsks). Each can
// still be filed; there is nothing left to dismiss.

import AskCard from './AskCard'

export default function AsksPanel({ item }) {
  const asks = (item.asks || []).filter((a) => a.kind !== 'blocking')
  const closed = item.parentClosedAsks || []
  if (asks.length === 0 && closed.length === 0) return null
  return (
    <section className="asks-panel" aria-label="Suggested follow-ups" data-testid="asks-panel">
      <div className="asks-panel__label">Suggested follow-ups</div>
      {asks.length > 0 && (
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
      )}
      {closed.length > 0 && (
        <>
          <div className="asks-panel__label asks-panel__label--closed">Closed with the item</div>
          <ul className="asks-panel__list" aria-label="Closed with the item">
            {closed.map((ask) => (
              <li key={ask.id} className="asks-panel__ask" data-testid="parent-closed-ask-row">
                <AskCard item={item} ask={ask} compact parentClosed />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
