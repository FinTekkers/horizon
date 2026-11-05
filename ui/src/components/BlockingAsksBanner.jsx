// HZ-730: the item's open blocking asks, prominently above its page: work a
// step said must be filed before this item can go on. Each is an AskCard, so
// the owner files or dismisses it in place.
//
// HZ-731: item.startHold (server/src/store.js) says what Implement or Execute
// waits for — an open blocking ask, or the item it filed until that merges or
// closes. It shows here even once no ask is open, since a filed ask leaves
// the open list while its item is still unmerged.

import AskCard, { effectiveDraft } from './AskCard'
import { itemHref } from './DependencyBadge'

export const blockingAsks = (item) => (item.asks || []).filter((a) => a.kind === 'blocking')

function StartHold({ hold }) {
  if (hold.filedItem) {
    return (
      <div className="ask-banner__hold" data-testid="ask-start-hold">
        Waiting for{' '}
        <a href={itemHref(hold.filedItem.id)} title={hold.filedItem.title}>
          {hold.filedItem.id}
        </a>{' '}
        to merge or close before “{hold.step}”
      </div>
    )
  }
  return (
    <div className="ask-banner__hold" data-testid="ask-start-hold">
      Waiting for ask “{hold.title}” before “{hold.step}”
    </div>
  )
}

export default function BlockingAsksBanner({ item }) {
  const asks = blockingAsks(item)
  const hold = item.startHold || null
  if (asks.length === 0 && !hold) return null
  return (
    <section className="ask-banner" role="alert" aria-label="Blocking asks">
      {hold && <StartHold hold={hold} />}
      {asks.map((ask) => (
        <div key={ask.id} className="ask-banner__ask">
          <div className="ask-banner__headline">This item needs “{effectiveDraft(ask).title}” filed first</div>
          <AskCard item={item} ask={ask} />
        </div>
      ))}
    </section>
  )
}
