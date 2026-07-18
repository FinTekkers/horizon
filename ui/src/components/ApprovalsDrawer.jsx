import { PHASES, curStep, phaseIdx, awaitingGate } from '../domain/lifecycle'
import { LockIcon } from './icons'

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
            const gateColor = optional ? '#5E4380' : '#9A6E00'
            const gateBg = optional ? '#F0E8F5' : '#FAF0D6'
            return (
              <div key={item.id} className="approval" style={{ borderLeft: `4px solid ${gateColor}` }}>
                <div className="approval__meta">
                  <span className="approval__id">{item.id}</span>
                  <span className="approval__gate-type" style={{ color: gateColor, background: gateBg }}>
                    {optional ? 'optional' : 'required'}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span className="approval__phase">{PHASES[phaseIdx(item)]}</span>
                </div>
                <div className="approval__title" onClick={() => onOpenItem(item.id)}>
                  {item.title}
                </div>
                <div className="approval__gate-label">
                  <LockIcon size={14} strokeWidth={2.4} />
                  {cur.label}
                </div>
                <div className="approval__actions">
                  <button className="btn-approve" onClick={() => onApprove(item.id)}>
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
