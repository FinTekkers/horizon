import { phasesFor, itemKindOf, curStep, phaseIdx, awaitingGate, ACCEPT_GATE_INDEX } from '../../../domain/js/lifecycle.js'
import { LockIcon } from './icons'
import { AutopilotOffChip, autopilotOffShown, AUTOPILOT_OFF_GATE_NOTE } from './StatusPill'

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

export default function ApprovalsDrawer({ items, onClose, onOpenItem, onApprove, onReject }) {
  const pending = items.filter(awaitingGate)
  const headline =
    pending.length > 0
      ? `${pending.length} gate${pending.length > 1 ? 's' : ''} waiting on a human decision`
      : 'Nothing waiting on you'

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
          {pending.map((item) => {
            const cur = curStep(item)
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
                  {cur.label}
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
                <div className="approval__actions">
                  <button className="btn-approve" onClick={() => onApprove(item.id, cur.label)}>
                    Approve
                  </button>
                  <button className="btn-reject" onClick={() => onReject(item.id, cur.label)}>
                    Send back
                  </button>
                </div>
              </div>
            )
          })}
          {pending.length === 0 && (
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
