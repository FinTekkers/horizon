export default function StatusPill({ status, className = 'status-pill' }) {
  return (
    <span className={className} style={{ color: status.color, background: status.bg }} title={status.reason}>
      <span className="status-pill__dot" style={{ background: status.color }} />
      {status.label}
    </span>
  )
}
