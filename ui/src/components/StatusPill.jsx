import { AutopilotOffIcon } from './icons'

export default function StatusPill({ status, className = 'status-pill' }) {
  return (
    <span className={className} style={{ color: status.color, background: status.bg }} title={status.reason}>
      <span className="status-pill__dot" style={{ background: status.color }} />
      {status.label}
    </span>
  )
}

// HZ-544: Autopilot is off for this item (its `autopilot-off` label) only
// counts in a project whose Autopilot is 'on' — the same rule the server
// records evaluations under (server/src/caretaker.js, itemOff).
export function autopilotOffShown(item) {
  return !!item?.autopilotOff && item.projectAutopilot === 'on'
}

// What a gate label adds when it is shown: "Accept the code · Autopilot is off for this item".
export const AUTOPILOT_OFF_GATE_NOTE = 'Autopilot is off for this item'

// Dark, so it stands apart from the status pills: a standing setting, not a state.
export function AutopilotOffChip({ item, className = '' }) {
  if (!autopilotOffShown(item)) return null
  return (
    <span className={`autopilot-off-chip${className ? ` ${className}` : ''}`}>
      <AutopilotOffIcon />
      Autopilot off
    </span>
  )
}
