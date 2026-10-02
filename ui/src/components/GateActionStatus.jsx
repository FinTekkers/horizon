import { useEffect, useState } from 'react'
import { gateActionView, elapsedText } from '../domain/gateAction'

// HZ-216: the Accept gate's long action — what it is doing and for how long
// while it runs (elapsed from the server's startedAt, so a reload shows the
// same clock), then its result. A blocked result names the failing check only,
// never its output.
// HZ-226: shared by the Tracker and the Board card. The card passes
// showElapsed={false}, so it starts no clock timer of its own.
export default function GateActionStatus({ action, pr, showElapsed = true }) {
  const view = gateActionView(action, pr)
  const running = view?.tone === 'running'
  const ticking = running && showElapsed
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  if (!view) return null
  return (
    <div className={`gate-action-status gate-action-status--${view.tone}`} role="status" aria-live="polite">
      <span className="gate-action-status__text">
        {view.text}
        {ticking && <span className="gate-action-status__elapsed"> · {elapsedText(action.since, now)}</span>}
      </span>
      {view.note && <span className="gate-action-status__note">{view.note}</span>}
    </div>
  )
}
