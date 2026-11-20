import { useEffect, useState } from 'react'
import { STEPS, stepIndexOf } from '../../../domain/js/lifecycle.js'
import { formatClarification, formatCost, formatDuration, formatTokens, formatTurns } from '../../../domain/js/itemStats.js'
import { getItemStats } from '../api'

// HZ-921: the item's Effort & cost summary — what the implementation took,
// the whole item's tokens, cost and time, and the clarification it needed.
// Tracker.jsx renders it only where domain/js/itemStats.js's statsVisible
// holds (the kind's last step, and closed or abandoned items). The figures
// are GET /api/items/:id/stats, the same object the item's GitHub stats
// comment holds, worded by the same formatters.

const stepLabel = (key) => STEPS[stepIndexOf(key)]?.label ?? key ?? 'an unknown step'
const count = (n) => (n == null ? 'not recorded' : n.toLocaleString('en-US'))
const tokensOf = (usage) => [
  ['Input', usage.input_tokens],
  ['Output', usage.output_tokens],
  ['Cache read', usage.cache_read_tokens],
  ['Cache write', usage.cache_write_tokens],
]

function Row({ label, children }) {
  return (
    <div className="effort-card__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function stepsText(rows) {
  return rows.map((row) => `${stepLabel(row.step)}${row.count > 1 ? ` ×${row.count}` : ''}`).join(', ')
}

function Implementation({ impl }) {
  return (
    <section className="effort-card__section" aria-label="Implementation">
      <h3 className="tile__label">Implementation</h3>
      {impl ? (
        <dl className="effort-card__list">
          <Row label="Cost">{formatCost(impl.cost_usd)}</Row>
          {tokensOf(impl).map(([label, n]) => (
            <Row key={label} label={`${label} tokens`}>
              {count(n)}
            </Row>
          ))}
          <Row label="Turns">{impl.turns == null ? 'not recorded' : formatTurns(impl.turns)}</Row>
          <Row label="Attempts">{impl.attempts}</Row>
          <Row label="Fix rounds">{impl.fix_rounds}</Row>
          <Row label="Wall time">{impl.wall_ms == null ? 'not recorded' : formatDuration(impl.wall_ms)}</Row>
        </dl>
      ) : (
        <p className="effort-card__note">This kind of item has no implement step.</p>
      )}
    </section>
  )
}

function WholeItem({ stats }) {
  const { totals, time, phases } = stats
  return (
    <section className="effort-card__section" aria-label="Whole item">
      <h3 className="tile__label">Whole item</h3>
      <dl className="effort-card__list">
        <Row label="Cost">{formatCost(totals.cost_usd)}</Row>
        {tokensOf(totals).map(([label, n]) => (
          <Row key={label} label={`${label} tokens`}>
            {count(n)}
          </Row>
        ))}
        <Row label="Turns">{totals.turns == null ? 'not recorded' : formatTurns(totals.turns)}</Row>
      </dl>
      <h4 className="effort-card__subhead">By phase</h4>
      <dl className="effort-card__list">
        {phases.map((p) => (
          <Row key={p.phase} label={p.phase}>
            {/* A phase with no run, or none recorded, says so once. */}
            {p.cost_usd == null && p.tokens == null ? 'none recorded' : `${formatCost(p.cost_usd)} · ${formatTokens(p.tokens)}`}
          </Row>
        ))}
      </dl>
      <h4 className="effort-card__subhead">Time</h4>
      <dl className="effort-card__list effort-card__time">
        <Row label={stats.closed_at ? 'Elapsed, created to closed' : 'Elapsed so far'}>{formatDuration(time.elapsed_ms)}</Row>
        <Row label="Agents working">{formatDuration(time.agent_ms)}</Row>
        <Row label="Waiting on you">{formatDuration(time.waiting_ms)}</Row>
        <Row label="Checks & deploys">{formatDuration(time.checks_deploy_ms)}</Row>
        <Row label="Queued">{formatDuration(time.queued_ms)}</Row>
      </dl>
    </section>
  )
}

function Clarification({ c }) {
  return (
    <section className="effort-card__section" aria-label="Clarification">
      <h3 className="tile__label">Clarification</h3>
      {c.none ? (
        <p className="effort-card__none">No clarification needed</p>
      ) : (
        <>
          <p className="effort-card__note">{formatClarification(c)}</p>
          <dl className="effort-card__list">
            {c.request_changes.length > 0 && <Row label="Request changes">{stepsText(c.request_changes)}</Row>}
            {c.review_fails.length > 0 && <Row label="Review send-backs">{stepsText(c.review_fails)}</Row>}
            {c.asks.blocking + c.asks.soft > 0 && (
              <Row label="Asks">
                {c.asks.blocking} blocking, {c.asks.soft} soft
              </Row>
            )}
            {c.caretaker_rulings.length > 0 && <Row label="Caretaker rulings">{stepsText(c.caretaker_rulings)}</Row>}
            {c.auto_retries > 0 && <Row label="Automatic retries">{c.auto_retries}</Row>}
            {c.usage_limit_fallbacks > 0 && <Row label="Usage-limit fallbacks">{c.usage_limit_fallbacks}</Row>}
          </dl>
        </>
      )}
      <dl className="effort-card__list">
        <Row label="Review cycles">{c.review_cycles}</Row>
      </dl>
    </section>
  )
}

export default function EffortCostCard({ item, load = getItemStats }) {
  // Kept with the item id and the state it was loaded for, so another item, a
  // step change or a close loads it afresh.
  const loadKey = `${item.id}|${item.cursor}|${item.abandoned_at ?? ''}`
  const [loaded, setLoaded] = useState(null)
  useEffect(() => {
    let live = true
    Promise.resolve()
      .then(() => load(item.id))
      .then(
        (data) => live && setLoaded({ key: loadKey, data, error: null }),
        () => live && setLoaded({ key: loadKey, data: null, error: 'The Effort & cost summary could not be loaded.' }),
      )
    return () => {
      live = false
    }
  }, [loadKey, item.id, load])

  const current = loaded?.key === loadKey ? loaded : null
  const stats = current?.data?.visible ? current.data.stats : null
  if (current && !current.error && !stats) return null
  return (
    <section className="panel effort-card" aria-labelledby={`effort-card-title-${item.id}`}>
      <h2 className="panel__title" id={`effort-card-title-${item.id}`}>
        Effort &amp; cost
      </h2>
      {!current && <p className="effort-card__note">Loading…</p>}
      {current?.error && (
        <p className="effort-card__note" role="alert">
          {current.error}
        </p>
      )}
      {stats && (
        <div className="effort-card__grid">
          <Implementation impl={stats.implementation} />
          <WholeItem stats={stats} />
          <Clarification c={stats.clarification} />
        </div>
      )}
    </section>
  )
}
