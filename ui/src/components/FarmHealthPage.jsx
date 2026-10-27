import { useClockTick } from '../useClockTick'

// HZ-563: Farm health, for admins — the farm's slots, what is running and
// waiting, the box and its services, and recent deploys and restarts. Laid
// out from the approved design (~/designs/horizon-farm-health-2026-10-23/).
// Read-only: the page only ever GETs /api/admin/farm-health; App.jsx owns the
// 10 s poll so this page and the account menu's dot read the same reading.

// The overall state's word, shared with the account menu's dot.
export const HEALTH_LABELS = { green: 'Healthy', amber: 'Busy', red: 'Unhealthy' }

const PREFIX = import.meta.env.BASE_URL.replace(/\/$/, '')
const GIB = 1024 ** 3

const SLOT_NAMES = { agent: 'Agent', pm: 'PM lane', check: 'Capacity', server: 'Server' }
const SLOT_NEEDS = { agent: 'an agent slot', pm: 'the PM lane', check: 'a capacity slot', server: 'the server' }
// HZ-574: a run whose agent session waits for a capacity slot keeps its agent
// slot, so it counts toward Agent slots busy while it waits.
const HOLDING_AGENT = 'holding an agent slot'
// HZ-592: a capacity-slot wait names its purpose (`reason`, from farmd); a
// row without one, from older farm code, falls back to the slot it needs.
const waitText = (w) => {
  const wait = w.reason || `needs ${SLOT_NEEDS[w.slot] || w.slot}`
  return w.holdsAgentSlot ? `${HOLDING_AGENT} · ${wait}` : wait
}

function elapsed(iso, now) {
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms)) return '—'
  const s = Math.max(0, Math.floor(ms / 1000))
  const pad = (n) => String(n).padStart(2, '0')
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`
  return `${Math.floor(s / 60)}m ${pad(s % 60)}s`
}

const utcTime = (iso) => {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 16) : '—'
}

function upFor(seconds) {
  if (!(seconds >= 0)) return null
  const days = Math.floor(seconds / 86400)
  if (days >= 1) return `${days} ${days === 1 ? 'day' : 'days'}`
  const hours = Math.floor(seconds / 3600)
  return hours >= 1 ? `${hours} ${hours === 1 ? 'hour' : 'hours'}` : `${Math.floor(seconds / 60)} min`
}

const gb = (bytes, digits = 1) => (bytes >= 0 ? `${(bytes / GIB).toFixed(digits)} GB` : '—')
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

function itemHref(id) {
  return `${PREFIX}/${String(id).toLowerCase()}`
}

function ItemLink({ id, onOpenItem }) {
  return (
    <a
      className="farm-health__item"
      href={itemHref(id)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        onOpenItem(id)
      }}
    >
      {id}
    </a>
  )
}

function SlotTile({ name, slot, tone, note }) {
  const limit = Math.max(0, slot.limit || 0)
  return (
    <div className="farm-health__tile">
      <span className="farm-health__tile-name">{name}</span>
      <span className="farm-health__tile-count">
        {slot.busy} <span className="farm-health__tile-of">of {limit} busy</span>
      </span>
      <div className="farm-health__cells" aria-hidden="true">
        {Array.from({ length: limit }, (_, i) => (
          <span key={i} className={`farm-health__cell${i < slot.busy ? ` farm-health__cell--${tone}` : ''}`} />
        ))}
      </div>
      <span className="farm-health__note">{note}</span>
    </div>
  )
}

function Meter({ name, value, pct, tone, note }) {
  const width = Math.max(0, Math.min(100, pct || 0))
  return (
    <div className="farm-health__meter">
      <div className="farm-health__meter-head">
        <span className="farm-health__meter-name">{name}</span>
        <span className="farm-health__meter-value">{value}</span>
      </div>
      <div className="farm-health__bar" aria-hidden="true">
        <span className={`farm-health__bar-fill farm-health__bar-fill--${tone}`} style={{ width: `${width}%` }} />
      </div>
      <span className="farm-health__meter-note">{note}</span>
    </div>
  )
}

function recentText(e) {
  if (e.kind === 'deploy') {
    const target = e.target ? e.target.charAt(0).toUpperCase() + e.target.slice(1) : 'A'
    return `${target} deploy ${e.tag || ''} went live`.replace(/\s+/g, ' ')
  }
  if (e.kind === 'farm_restart') return 'Farm restarted'
  if (e.kind === 'server_restart') return 'Horizon server restarted'
  return e.kind
}

// HZ-574: who holds each capacity slot and what it is checking, then the runs
// waiting for one. farmd records the slot's label only, never the command.
function CheckSlots({ data, now, onOpenItem }) {
  const { checks } = data.capacity
  const holders = data.checkHolders || []
  // A slot busy with no record: a run on farm code from before HZ-574.
  const unrecorded = Math.max(0, (checks.busy || 0) - holders.length)
  const waiters = data.waiting.filter((w) => w.slot === 'check')
  const reachable = data.farm.status !== 'not_running'
  return (
    <section aria-labelledby="farm-health-chk" className="farm-health__card">
      <div className="farm-health__card-head">
        <h2 id="farm-health-chk" className="farm-health__h2">
          Capacity slots
        </h2>
        <span className="farm-health__count">
          {checks.busy} of {Math.max(0, checks.limit || 0)} busy
        </span>
      </div>
      {!reachable ? (
        <p className="farm-health__empty">Farm not reachable — no capacity slot readings</p>
      ) : holders.length + unrecorded === 0 ? (
        <p className="farm-health__empty">No capacity slot in use</p>
      ) : (
        <table className="farm-health__table">
          <thead>
            <tr>
              <th>Slot</th>
              <th>Item</th>
              <th>Check</th>
              <th className="farm-health__num">For</th>
            </tr>
          </thead>
          <tbody>
            {holders.map((h) => (
              <tr key={`slot-${h.slot}`}>
                <td>Slot {h.slot}</td>
                <td>{h.itemId ? <ItemLink id={h.itemId} onOpenItem={onOpenItem} /> : '—'}</td>
                <td>
                  {h.label || '—'}
                  {h.caller && <span className="farm-health__muted"> · {h.caller}</span>}
                </td>
                <td className="farm-health__num">{elapsed(h.startedAt, now)}</td>
              </tr>
            ))}
            {Array.from({ length: unrecorded }, (_, i) => (
              <tr key={`unrecorded-${i}`}>
                <td className="farm-health__muted">—</td>
                <td className="farm-health__muted" colSpan={3}>
                  In use · no record
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3 className="farm-health__h3">Waiting for a capacity slot</h3>
      {waiters.length === 0 ? (
        <p className="farm-health__empty">Nothing waiting</p>
      ) : (
        <table className="farm-health__table">
          <tbody>
            {waiters.map((w, i) => (
              <tr key={`${w.itemId}-${i}`}>
                <td>
                  <ItemLink id={w.itemId} onOpenItem={onOpenItem} />
                </td>
                <td>{w.step}</td>
                <td className="farm-health__muted">{waitText(w)}</td>
                <td className="farm-health__num">{elapsed(w.startedAt, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function Sections({ data, now, onOpenItem }) {
  const { capacity, box } = data
  const load = box.load || []
  const vcpus = box.vcpus || 0
  const loadAmber = vcpus > 0 && load[0] > 1.25 * vcpus
  const memAmber = box.memAvailablePct != null && box.memAvailablePct < 15
  const disk = box.diskUsedPct
  const diskTone = disk > 90 ? 'red' : disk > 75 ? 'amber' : 'green'
  const up = data.services.filter((s) => s.up).length
  const allUp = up === data.services.length
  const boxUp = upFor(box.uptimeS)
  const farmLine =
    data.farm.status === 'running' && data.farm.since
      ? `Farm running since ${utcTime(data.farm.since)} UTC`
      : 'Farm not running'
  const agentsWaiting = capacity.agents.waiting
  const expressName = capacity.express.limit === 1 ? 'Express slot' : 'Express slots'

  return (
    <>
      <section aria-label="Overall" className={`farm-health__overall farm-health__overall--${data.state}`} data-state={data.state}>
        <span className="farm-health__overall-state">
          <span className={`farm-health__dot farm-health__dot--${data.state} farm-health__dot--lg`} aria-hidden="true" />
          {HEALTH_LABELS[data.state]}
        </span>
        <span className="farm-health__overall-reason">{data.reason}</span>
        <span className="farm-health__spacer" />
        <span className="farm-health__overall-meta">
          {farmLine}
          {boxUp && ` · box up ${boxUp}`}
        </span>
      </section>

      <section aria-labelledby="farm-health-cap" className="farm-health__capacity">
        <h2 id="farm-health-cap" className="farm-health__h2">
          Capacity
        </h2>
        <div className="farm-health__tiles">
          <SlotTile
            name="Agent slots"
            slot={capacity.agents}
            tone="agent"
            note={agentsWaiting > 0 ? `${plural(agentsWaiting, 'item', 'items')} waiting for one` : 'None waiting'}
          />
          <SlotTile name={expressName} slot={capacity.express} tone="lane" note="Short steps only" />
          <SlotTile
            name="PM lane"
            slot={capacity.pm}
            tone="lane"
            note={capacity.pm.waiting > 0 ? `${capacity.pm.waiting} waiting` : 'Plan and summary steps'}
          />
          <SlotTile
            name="Capacity slots"
            slot={capacity.checks}
            tone="check"
            note={capacity.checks.waiting > 0 ? `${capacity.checks.waiting} waiting` : 'None waiting'}
          />
        </div>
      </section>

      <div className="farm-health__row">
        <section aria-labelledby="farm-health-run" className="farm-health__card">
          <div className="farm-health__card-head">
            <h2 id="farm-health-run" className="farm-health__h2">
              Running now
            </h2>
            <span className="farm-health__count">{plural(data.running.length, 'step', 'steps')}</span>
          </div>
          {data.running.length === 0 ? (
            <p className="farm-health__empty">Nothing running</p>
          ) : (
            <table className="farm-health__table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Step</th>
                  <th className="farm-health__slot-col">Slot</th>
                  <th className="farm-health__num">Running for</th>
                </tr>
              </thead>
              <tbody>
                {data.running.map((r, i) => (
                  <tr key={`${r.itemId}-${i}`}>
                    <td>
                      <ItemLink id={r.itemId} onOpenItem={onOpenItem} />
                    </td>
                    <td>{r.step}</td>
                    <td className="farm-health__slot-col">
                      <span className={`farm-health__slot farm-health__slot--${r.slot}`}>{SLOT_NAMES[r.slot] || r.slot}</span>
                    </td>
                    <td className="farm-health__num">{elapsed(r.startedAt, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h3 className="farm-health__h3">Waiting for a slot</h3>
          {data.waiting.length === 0 ? (
            <p className="farm-health__empty">Nothing waiting</p>
          ) : (
            <table className="farm-health__table">
              <tbody>
                {data.waiting.map((w, i) => (
                  <tr key={`${w.itemId}-${i}`}>
                    <td>
                      <ItemLink id={w.itemId} onOpenItem={onOpenItem} />
                    </td>
                    <td>{w.step}</td>
                    <td className="farm-health__slot-col farm-health__muted">{waitText(w)}</td>
                    <td className="farm-health__num">{elapsed(w.startedAt, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="farm-health__foot">
            Items waiting at a gate for a person are not listed here: they are under Pending approvals.
          </p>
        </section>

        <section aria-labelledby="farm-health-box" className="farm-health__card farm-health__card--box">
          <h2 id="farm-health-box" className="farm-health__h2">
            Box
          </h2>
          <Meter
            name="CPU load"
            value={load.length ? load.map((n) => n.toFixed(2)).join(' · ') : '—'}
            pct={vcpus > 0 ? (load[0] / vcpus) * 100 : 0}
            tone={loadAmber ? 'amber' : 'green'}
            note={`1, 5 and 15-minute load on ${vcpus} vCPUs. Above ${(1.25 * vcpus).toFixed(1)} shows amber.`}
          />
          <Meter
            name="Memory"
            value={`${gb(box.memAvailableBytes)} available of ${gb(box.memTotalBytes)}`}
            pct={box.memAvailablePct != null ? 100 - box.memAvailablePct : 0}
            tone={memAmber ? 'amber' : 'green'}
            note="Amber below 15% available."
          />
          <Meter
            name="Disk"
            value={`${disk != null ? Math.round(disk) : '—'}% used · ${gb(box.diskAvailBytes, 0)} free of ${gb(box.diskTotalBytes, 0)}`}
            pct={disk}
            tone={diskTone}
            note="Amber above 75%, red above 90%. Worktrees are the usual growth."
          />
          <div className="farm-health__box-foot">
            <span>
              {[box.machine, `${vcpus} vCPU`, box.memTotalBytes ? `${Math.ceil(box.memTotalBytes / GIB)} GB` : null]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <span>{box.swapTotalBytes > 0 ? 'Swap on' : 'Swap off'}</span>
            {boxUp && <span>Up {boxUp}</span>}
          </div>
        </section>
      </div>

      <div className="farm-health__row">
        <CheckSlots data={data} now={now} onOpenItem={onOpenItem} />
      </div>

      <div className="farm-health__row">
        <section aria-labelledby="farm-health-svc" className="farm-health__card">
          <div className="farm-health__card-head">
            <h2 id="farm-health-svc" className="farm-health__h2">
              Services
            </h2>
            <span className={`farm-health__svc-count${allUp ? '' : ' farm-health__svc-count--down'}`}>
              {up} of {data.services.length} up
            </span>
          </div>
          <ul className="farm-health__services">
            {data.services.map((v) => (
              <li key={v.unit || v.name} className="farm-health__service" title={v.unit || undefined} data-up={v.up}>
                <span className={`farm-health__dot farm-health__dot--${v.up ? 'green' : 'red'}`} aria-hidden="true" />
                <span className="farm-health__service-name">{v.name}</span>
                <span className="farm-health__spacer" />
                <span className="farm-health__service-detail">{v.up ? v.detail || v.state : v.state === 'unknown' ? 'down' : v.state}</span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="farm-health-ev" className="farm-health__card">
          <h2 id="farm-health-ev" className="farm-health__h2">
            Recent
          </h2>
          {data.recent.length === 0 ? (
            <p className="farm-health__empty">Nothing in the last 24 hours</p>
          ) : (
            data.recent.map((e, i) => (
              <div key={`${e.kind}-${e.at}-${i}`} className="farm-health__event">
                <span className="farm-health__event-at">{utcTime(e.at)}</span>
                <span>{recentText(e)}</span>
              </div>
            ))
          )}
        </section>
      </div>
    </>
  )
}

// health: { data, error, loading } from App.jsx's poll.
export default function FarmHealthPage({ health, onRefresh, onOpenItem }) {
  useClockTick(1000)
  const now = Date.now()
  const { data, error, loading } = health
  const ago = data ? Math.max(0, Math.round((now - Date.parse(data.collectedAt)) / 1000)) : null
  const warming = !data && (loading || error === 'farm_health_warming')

  return (
    <main className="farm-health">
      <div className="farm-health__head">
        <div className="farm-health__titles">
          <h1 className="farm-health__h1">Farm health</h1>
          <p className="farm-health__sub">Is the farm running, how much room does it have, and is the box keeping up.</p>
        </div>
        <div className="farm-health__refresh">
          <span>{ago != null ? `Updated ${ago}s ago · refreshes every 10 s` : 'Refreshes every 10 s'}</span>
          <button type="button" className="farm-health__refresh-btn" onClick={onRefresh} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>

      {warming && <p className="farm-health__empty">Collecting the first reading…</p>}
      {error && !warming && (
        <p className="farm-health__error" role="alert">
          {data ? 'Could not refresh — showing the last reading.' : 'Could not load Farm health.'}
        </p>
      )}

      {data && <Sections data={data} now={now} onOpenItem={onOpenItem} />}

      <section aria-label="How the state is worked out" className="farm-health__rules">
        <strong>How the state is worked out.</strong> Red: a service is down, the farm is not running, or disk is above
        90%. Amber (busy): every agent slot is busy, items are waiting for a slot, 1-minute load is above 1.25× the
        vCPUs, available memory is below 15%, or disk is above 75%. Green otherwise. The same rules colour each tile and
        the dot in the menu.
      </section>
    </main>
  )
}
