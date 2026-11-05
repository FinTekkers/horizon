// HZ-730: every open soft ask on the items the board shows (the TopBar's
// project filter applies), grouped by item, newest item activity first, for
// triage in batches. Each is an AskCard, so filing and dismissing happen in
// place. Built from the board snapshot's item.asks — no request of its own.

import AskCard from './AskCard'

export const softAsks = (item) => (item.asks || []).filter((a) => a.kind === 'soft')

export function followUpGroups(items) {
  return items
    .map((item) => ({ item, asks: softAsks(item) }))
    .filter((g) => g.asks.length > 0)
    .sort((a, b) => String(b.asks[0].created_at ?? '').localeCompare(String(a.asks[0].created_at ?? '')) || a.item.id.localeCompare(b.item.id))
}

export default function FollowUpsPage({ items, onOpenItem }) {
  const groups = followUpGroups(items)
  const count = groups.reduce((n, g) => n + g.asks.length, 0)
  return (
    <main className="follow-ups">
      <h1 className="follow-ups__title">Follow-ups</h1>
      <p className="follow-ups__sub">
        {count === 0 ? 'No suggested follow-ups on the items shown.' : `${count} suggested follow-up${count > 1 ? 's' : ''} to file or dismiss.`}
      </p>
      {groups.map(({ item, asks }) => (
        <section key={item.id} className="follow-ups__group" aria-label={`Follow-ups from ${item.id}`}>
          <div className="follow-ups__item">
            <button type="button" className="follow-ups__item-id" onClick={() => onOpenItem(item.id)}>
              {item.id}
            </button>
            <span className="follow-ups__item-title">{item.title}</span>
          </div>
          {asks.map((ask) => (
            <AskCard key={ask.id} item={item} ask={ask} compact />
          ))}
        </section>
      ))}
    </main>
  )
}
