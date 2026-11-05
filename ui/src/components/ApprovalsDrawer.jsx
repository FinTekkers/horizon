import { phasesFor, itemKindOf, curStep, phaseIdx, awaitingGate, ACCEPT_GATE_INDEX } from '../../../domain/js/lifecycle.js'
import { stepLabel } from '../../../domain/js/substeps.js'
import { LockIcon } from './icons'
import { AutopilotOffChip, autopilotOffShown, AUTOPILOT_OFF_GATE_NOTE } from './StatusPill'
import AskCard from './AskCard'
import StepActionMenu from './StepActionMenu'
import { blockingAsks } from './BlockingAsksBanner'

// HZ-544: what Autopilot would have done at this gate, from the server's
// item.autopilotWouldHave (an evaluation at the item's current gate only).
const WOULD_HAVE = {
  approve: (item) => (item.cursor === ACCEPT_GATE_INDEX ? 'accepted' : 'approved'),
  send_back: () => 'sent it back',
  resolve_conflicts: () => 'resolved the conflicts',
  wait: () => 'waited',
  ping_human: () => 'asked for you',
}

function autopilotOffNote(item) {
  const would = item.autopilotWouldHave
  const verb = would && WOULD_HAVE[would.decision]?.(item)
  const reason = String(would?.reason ?? '').trim().replace(/\.$/, '')
  const tail = verb ? ` Autopilot would have ${verb}${reason ? `: ${reason}` : ''}.` : ''
  return `Waiting for you because Autopilot is off for this item.${tail}`
}

// HZ-730: `askItems` are items with open blocking asks; each ask is listed
// first, under "Blocking asks", to file or dismiss in place. HZ-711: each gate
// offers the item page's own menu (StepActionMenu).
export default function ApprovalsDrawer({ items, askItems = [], onClose, onOpenItem, onApprove, onMove, onAbandon }) {
  const pending = items.filter(awaitingGate)
  const asks = askItems.flatMap((item) => blockingAsks(item).map((ask) => ({ item, ask })))
  const parts = [
    pending.length > 0 && `${pending.length} gate${pending.length > 1 ? 's' : ''}`,
    asks.length > 0 && `${asks.length} blocking ask${asks.length > 1 ? 's' : ''}`,
  ].filter(Boolean)
  const headline = parts.length > 0 ? `${parts.join(' and ')} waiting on a human decision` : 'Nothing waiting on you'

  return (
    <div className="drawer">
      <div className="drawer__scrim" onClick={onClose} />
      <div className="drawer__panel">
        <div className="drawer__head">
          <div>
            <div className="drawer__title">Pending approvals</div>
            <div className="drawer__subtitle">{headline}</div>
          </div>
          <button className="drawer__close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="drawer__list">
          {asks.length > 0 && (
            <section className="approval-asks" aria-label="Blocking asks">
              <div className="approval-asks__label">Blocking asks</div>
              {asks.map(({ item, ask }) => (
                <div key={ask.id} className="approval approval--ask" data-testid="approval-ask">
                  <div className="approval__meta">
                    <span className="approval__id">{item.id}</span>
                  </div>
                  <div className="approval__title" onClick={() => onOpenItem(item.id)}>
                    {item.title}
                  </div>
                  <AskCard item={item} ask={ask} compact />
                </div>
              ))}
            </section>
          )}
          {pending.map((item) => {
            const cur = curStep(item)
            // HZ-540: the sub-step's label when the item is at one.
            const label = stepLabel(item)
            const optional = cur.gate === 'optional'
            const gateColor = optional ? 'var(--agent-human-ink)' : 'var(--warning-ink)'
            const gateBg = optional ? 'var(--agent-human-bg)' : 'var(--warning-bg)'
            const off = autopilotOffShown(item)
            return (
              <div key={item.id} className="approval" style={{ borderLeft: `4px solid ${gateColor}` }}>
                <div className="approval__meta">
                  <span className="approval__id">{item.id}</span>
                  <AutopilotOffChip item={item} />
                  <span className="approval__gate-type" style={{ color: gateColor, background: gateBg }}>
                    {optional ? 'optional' : 'required'}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span className="approval__phase">{phasesFor(itemKindOf(item))[phaseIdx(item)]}</span>
                </div>
                <div className="approval__title" onClick={() => onOpenItem(item.id)}>
                  {item.title}
                </div>
                <div className="approval__gate-label">
                  <LockIcon size={14} strokeWidth={2.4} />
                  {label}
                  {off && ` · ${AUTOPILOT_OFF_GATE_NOTE}`}
                </div>
                {off && (
                  <div className="autopilot-off-note autopilot-off-note--approval">
                    {autopilotOffNote(item)}
                    {item.cursor === ACCEPT_GATE_INDEX && item.pr_url && (
                      <a className="autopilot-off-note__link" href={item.pr_url} target="_blank" rel="noopener noreferrer">
                        Open the PR diff
                      </a>
                    )}
                  </div>
                )}
                <StepActionMenu item={item} onApprove={onApprove} onMove={onMove} onAbandon={onAbandon} className="approval__actions" />
              </div>
            )
          })}
          {pending.length === 0 && asks.length === 0 && (
            <div className="all-clear">
              <div className="all-clear__icon">✓</div>
              <div className="all-clear__title">All clear</div>
              <div className="all-clear__sub">No gates waiting on you right now.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
