// HZ-730: the item's open blocking asks, prominently above its page: work a
// step said must be filed before this item can go on. Each is an AskCard, so
// the owner files or dismisses it in place.

import AskCard, { effectiveDraft } from './AskCard'

export const blockingAsks = (item) => (item.asks || []).filter((a) => a.kind === 'blocking')

export default function BlockingAsksBanner({ item }) {
  const asks = blockingAsks(item)
  if (asks.length === 0) return null
  return (
    <section className="ask-banner" role="alert" aria-label="Blocking asks">
      {asks.map((ask) => (
        <div key={ask.id} className="ask-banner__ask">
          <div className="ask-banner__headline">This item needs “{effectiveDraft(ask).title}” filed first</div>
          <AskCard item={item} ask={ask} />
        </div>
      ))}
    </section>
  )
}
