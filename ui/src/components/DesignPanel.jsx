import { latestRoundOf, roundsOf, safeCanvasUrl } from '../../../domain/js/designRounds.js'

// HO-853: an item's design on its first gate, beside the golden cases — the
// server's item.designSpec (HO-852) and the design sub-step's rounds (HO-851).
// It shows the latest round's canvas link, brief and what changed, and lists
// every round, each opening its own canvas. While the gate waits, "Request
// changes" sends the item back to the design sub-step (the server's own target,
// through MoveDialog: `onRequestChanges` is null when the snapshot lists none),
// and "Approve without design" asks for a reason. Once approved it says what
// was approved. A canvas link is drawn only as an https URL (safeCanvasUrl);
// every value renders as React text.

const KIND_TEXT = { skip: 'Skipped', forced: 'Designed anyway' }

function CanvasLink({ url, children }) {
  const href = safeCanvasUrl(url)
  if (!href) return null
  return (
    <a className="design-panel__canvas" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

function Status({ spec }) {
  if (spec.approved && spec.skipReason) {
    return (
      <div className="design-panel__status" data-testid="design-skip-reason">
        Approved without design by {spec.approvedBy}: {spec.skipReason}
      </div>
    )
  }
  if (spec.approved) {
    return (
      <div className="design-panel__status">
        Canvas approved by {spec.approvedBy}
        {safeCanvasUrl(spec.canvasUrl) && ' · '}
        <CanvasLink url={spec.canvasUrl}>Approved canvas ↗</CanvasLink>
      </div>
    )
  }
  if (spec.verdictSkipReason) {
    return (
      <div className="design-panel__status design-panel__status--note">
        The agent said no design is needed: {spec.verdictSkipReason}. Approve as it is, or use “Design it anyway” on the design row above.
      </div>
    )
  }
  if (spec.pendingRunId == null) {
    return (
      <div className="design-panel__status design-panel__status--warn" role="status">
        This round has no canvas yet. Request changes, or approve without design.
      </div>
    )
  }
  return <div className="design-panel__status">Approving this gate approves the latest canvas.</div>
}

export default function DesignPanel({ item, spec, sub, busy = false, onRequestChanges = null, onApproveWithoutDesign = null }) {
  const rounds = roundsOf(sub)
  const latest = latestRoundOf(sub)
  const titleId = `design-panel-${item.id}`
  return (
    <section className="design-panel" data-testid="design-panel" aria-labelledby={titleId}>
      <div className="design-panel__title" id={titleId}>
        Design{latest ? ` · Round ${latest.round}` : ''}
      </div>
      <Status spec={spec} />
      {latest && (
        <div className="design-panel__latest" data-testid="design-latest">
          <div className="design-panel__round-head">
            <span className="design-panel__round">Round {latest.round}</span>
            {Object.hasOwn(KIND_TEXT, latest.kind) && <span className="design-panel__kind">{KIND_TEXT[latest.kind]}</span>}
            <CanvasLink url={latest.canvasUrl}>Open the latest canvas ↗</CanvasLink>
          </div>
          <dl className="design-panel__facts">
            <dt>Brief</dt>
            <dd>{latest.brief || '—'}</dd>
            {latest.kind !== 'skip' && (
              <>
                <dt>What changed</dt>
                <dd>{latest.whatChanged || '—'}</dd>
              </>
            )}
          </dl>
        </div>
      )}
      {rounds.length > 1 && (
        <ol className="design-panel__rounds" aria-label="Design rounds">
          {rounds.map((r) => (
            <li key={r.round} className="design-panel__round-item">
              {safeCanvasUrl(r.canvasUrl) ? (
                <CanvasLink url={r.canvasUrl}>Round {r.round} canvas ↗</CanvasLink>
              ) : (
                <span className="design-panel__round-plain">
                  Round {r.round}
                  {r.kind === 'skip' ? ' · skipped' : ' · no canvas'}
                </span>
              )}
              <span className="design-panel__round-brief">{r.brief}</span>
            </li>
          ))}
        </ol>
      )}
      {(onRequestChanges || onApproveWithoutDesign) && (
        <div className="design-panel__actions">
          {onRequestChanges && (
            <button type="button" className="btn-gate-feedback" disabled={busy} aria-busy={busy || undefined} onClick={onRequestChanges}>
              Request changes
            </button>
          )}
          {onApproveWithoutDesign && (
            <button type="button" className="btn-gate-feedback" disabled={busy} aria-busy={busy || undefined} onClick={onApproveWithoutDesign}>
              Approve without design
            </button>
          )}
        </div>
      )}
    </section>
  )
}
