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

// HZ-670: farmd's hourly count of defunct processes, by the parent pid that
// has yet to reap them. Null when farmd is down or cleanup is off.
function zombiesText(z) {
  if (!z) return 'Defunct processes: not measured'
  return [`Defunct processes: ${z.count}`, ...(z.parents || []).map((p) => `PID ${p.ppid} holds ${p.count}`)].join(' · ')
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

// ---- HZ-969: Design steps ----
// Read-only, from the snapshot's `design` block: the tool farmd's resolve()
// picks, the Claude Design probe record, each project's design sub-step and
// the last design rounds. A part that could not be read says so here only.

const CHOSEN_NAMES = { studio: 'Studio', claude: 'Claude', html: 'Horizon pages' }
const TOOL_NAMES = { studio: 'Studio', claude: 'Claude Design', html: 'Horizon pages' }
const ROUND_TOOL_NAMES = { studio: 'Studio', claude: 'Claude Design', html: 'Horizon page' }
const ROUND_RESULTS = { run: 'Ran', forced: 'Ran (forced)', skip: 'Skipped' }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "22 Nov, 10:42 UTC", or null for a missing or bad time.
function dayTime(iso, comma = ',') {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${comma} ${d.toISOString().slice(11, 16)} UTC`
}

const maxAgeDays = (design) => Math.round((design.maxAgeS || 7 * 86400) / 86400)

// Why a chosen tool fell back, in a few words.
function fallbackShort(design) {
  if (design.fallbackFrom === 'studio') return '`meta` not installed'
  const { state, fresh } = design.probe
  if (state === 'failed') return 'probe failed'
  if (state === 'none') return 'probe never run'
  if (state === 'unreadable') return 'probe record unreadable'
  if (fresh === false) return `probe older than ${maxAgeDays(design)} days`
  return 'cannot run here'
}

// The section's header badge: [tone, text].
function designBadge(design) {
  if (design.status !== 'ok') return ['muted', 'Unknown']
  if (design.chosen === 'invalid') return ['red', 'Design rounds fail']
  if (design.tool === 'html' && design.htmlReady === false) return ['red', "Horizon pages can't be drawn"]
  if (design.fallbackFrom) return ['amber', `On, drawing Horizon pages instead of ${TOOL_NAMES[design.fallbackFrom]}`]
  return ['green', `On, drawing with ${TOOL_NAMES[design.tool] || design.tool}`]
}

// Backticked words as <code>, the rest as text.
function Ticked({ text }) {
  return String(text ?? '')
    .split(/(`[^`]+`)/)
    .map((part, i) => (part.startsWith('`') && part.endsWith('`') && part.length > 2 ? <code key={i}>{part.slice(1, -1)}</code> : part))
}

function ToolCard({ design }) {
  const invalid = design.chosen === 'invalid'
  const htmlMissing = design.tool === 'html' && design.htmlReady === false
  let line
  if (invalid) line = 'Design rounds fail: the setting names no tool'
  else if (design.fallbackFrom) line = `${CHOSEN_NAMES[design.chosen]} chosen, ${fallbackShort(design)} → drawing Horizon pages`
  else line = `${CHOSEN_NAMES[design.chosen]} chosen → drawing with ${TOOL_NAMES[design.tool] || design.tool}`
  if (htmlMissing) line += ', but the capture worker is missing'
  return (
    <section aria-labelledby="farm-health-design-tool" className="farm-health__card">
      <h3 id="farm-health-design-tool" className="farm-health__h3 farm-health__design-title">
        Tool in use
      </h3>
      <p className={`farm-health__design-tool farm-health__design-tool--${invalid || htmlMissing ? 'red' : design.fallbackFrom ? 'amber' : 'green'}`} data-testid="farm-health-design-tool">
        <Ticked text={line} />
      </p>
      <dl className="farm-health__design-facts">
        <dt>Setting</dt>
        <dd>
          <code>FARM_DESIGN_BACKEND</code> {invalid ? 'names no tool' : <>reads <code>{design.chosen}</code></>} (unset means <code>studio</code>)
        </dd>
        {!invalid && (
          <>
            <dt>Rounds use</dt>
            <dd>
              {TOOL_NAMES[design.tool] || '—'}
              {design.tool && (
                <>
                  {' '}
                  (<code>{design.tool}</code>)
                </>
              )}
            </dd>
          </>
        )}
        {design.reason && (
          <>
            <dt>Why</dt>
            <dd>
              <Ticked text={design.reason} />
            </dd>
          </>
        )}
        {htmlMissing && design.htmlReason && (
          <>
            <dt>Capture worker</dt>
            <dd>
              <Ticked text={design.htmlReason} />
            </dd>
          </>
        )}
      </dl>
      <p className="farm-health__foot">
        To change the tool, set <code>FARM_DESIGN_BACKEND</code> in the farm&apos;s env. This page only reads it.
      </p>
    </section>
  )
}

const PROBE_TAGS = { passed: ['green', 'Passed'], failed: ['red', 'Failed'], none: ['muted', 'Never run'], unreadable: ['red', 'Unreadable'] }

function ProbeCard({ design }) {
  const { probe } = design
  const days = maxAgeDays(design)
  const stale = probe.state === 'passed' && probe.fresh === false
  const [tone, tag] = stale ? ['amber', 'Passed, stale'] : PROBE_TAGS[probe.state] || ['muted', 'Unknown']
  const checked = dayTime(probe.checkedAt)
  const until = Number.isFinite(Date.parse(probe.checkedAt)) ? dayTime(new Date(Date.parse(probe.checkedAt) + days * 86400000).toISOString()) : null
  let turnsOn = 'Yes'
  if (design.tool !== 'claude') {
    if (design.chosen !== 'claude') turnsOn = 'Not chosen on this box'
    else if (probe.state === 'failed') turnsOn = 'No, because the last probe failed'
    else if (stale) turnsOn = `No, because it is older than ${days} days`
    else turnsOn = 'No, no probe has passed'
  }
  return (
    <section aria-labelledby="farm-health-design-probe" className="farm-health__card">
      <div className="farm-health__card-head">
        <h3 id="farm-health-design-probe" className="farm-health__h3 farm-health__design-title">
          Claude Design probe
        </h3>
        <span className={`farm-health__tag farm-health__tag--${tone}`}>{tag}</span>
      </div>
      {probe.state === 'none' ? (
        <p className="farm-health__empty">
          There is no probe record on this box (<code>state/design-claude-probe.json</code>).
        </p>
      ) : probe.state === 'unreadable' ? (
        <p className="farm-health__empty">
          The probe record (<code>state/design-claude-probe.json</code>) can&apos;t be read.
        </p>
      ) : (
        <dl className="farm-health__design-facts">
          <dt>Checked</dt>
          <dd>{checked || 'Unknown'}</dd>
          <dt>Fresh</dt>
          <dd>
            {probe.fresh === true
              ? `Yes. It counts for ${days} days, until ${until}`
              : probe.fresh === false
                ? `No, older than ${days} days`
                : 'Unknown'}
          </dd>
          <dt>Turns on Claude Design</dt>
          <dd>{turnsOn}</dd>
        </dl>
      )}
      {probe.state === 'failed' && probe.label && (
        <p className="farm-health__design-why">
          <Ticked text={probe.label} />
        </p>
      )}
      <p className="farm-health__foot">
        To re-check, run <code>python -m farm.design_backend probe-claude</code> on the box.
      </p>
    </section>
  )
}

const DESIGN_TAGS = { on: ['green', 'On'], off: ['muted', 'Off'], unknown: ['red', 'Unreadable'] }

function appliesText(p) {
  return [...p.repos, ...p.labels.map((l) => `label ${l}`), ...p.paths].join(', ')
}

function ProjectsCard({ design }) {
  const projects = design.projects || []
  const on = projects.filter((p) => p.design === 'on').length
  return (
    <section aria-labelledby="farm-health-design-projects" className="farm-health__card">
      <div className="farm-health__card-head">
        <h3 id="farm-health-design-projects" className="farm-health__h3 farm-health__design-title">
          Projects with the design sub-step
        </h3>
        {design.projectsStatus === 'ok' && (
          <span className="farm-health__count">
            {on} of {projects.length} on
          </span>
        )}
      </div>
      {design.projectsStatus !== 'ok' ? (
        <p className="farm-health__empty">Projects unknown: their steps.json files could not be read.</p>
      ) : projects.length === 0 ? (
        <p className="farm-health__empty">No projects.</p>
      ) : (
        <table className="farm-health__table farm-health__design-table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Design sub-step</th>
              <th>Applies to</th>
              <th>Definitions switch</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => {
              const [tone, tag] = DESIGN_TAGS[p.design] || DESIGN_TAGS.unknown
              return (
                <tr key={p.name} data-design={p.design}>
                  <td>
                    <strong>{p.name}</strong>
                    <span className="farm-health__design-file">{p.file ? <code>{p.file}</code> : <>no <code>steps.json</code></>}</span>
                  </td>
                  <td>
                    <span className={`farm-health__tag farm-health__tag--${tone}`}>{tag}</span>{' '}
                    {p.design === 'on'
                      ? p.label
                      : p.design === 'unknown'
                        ? "steps.json can't be read"
                        : p.definitions === 'off'
                          ? 'definitions switched off'
                          : p.file
                            ? 'no design sub-step'
                            : null}
                  </td>
                  <td>{p.design === 'on' ? appliesText(p) || 'None' : 'None'}</td>
                  <td className="farm-health__design-defs">Definitions {p.definitions === 'on' ? 'on' : 'off'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}

function RoundsCard({ design, onOpenItem }) {
  const rounds = design.rounds || []
  return (
    <section aria-labelledby="farm-health-design-rounds" className="farm-health__card">
      <div className="farm-health__card-head">
        <h3 id="farm-health-design-rounds" className="farm-health__h3 farm-health__design-title">
          Last design rounds
        </h3>
        {rounds.length > 0 && <span className="farm-health__count">Last {rounds.length}</span>}
      </div>
      {design.roundsStatus !== 'ok' ? (
        <p className="farm-health__empty">Design rounds unknown: they could not be read.</p>
      ) : rounds.length === 0 ? (
        <p className="farm-health__empty">No design rounds yet.</p>
      ) : (
        <table className="farm-health__table farm-health__design-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>When</th>
              <th>Tool</th>
              <th>Result</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {rounds.map((r, i) => (
              <tr key={`${r.itemId}-${r.round}-${i}`} data-kind={r.kind}>
                <td>{r.itemId ? <ItemLink id={r.itemId} onOpenItem={onOpenItem} /> : '—'}</td>
                <td className="farm-health__muted">{dayTime(r.at, '') || '—'}</td>
                <td>
                  {ROUND_TOOL_NAMES[r.tool] || (r.kind === 'skip' ? 'None' : 'Not recorded')}
                  {r.fallbackFrom && <span className="farm-health__design-file">fell back from {TOOL_NAMES[r.fallbackFrom]}</span>}
                </td>
                <td>
                  <span className={`farm-health__tag farm-health__tag--${r.kind === 'skip' ? 'amber' : 'green'}`}>{ROUND_RESULTS[r.kind] || '—'}</span>
                </td>
                <td>
                  <Ticked text={r.why || '—'} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

export function DesignSteps({ design, onOpenItem }) {
  const d = design || { status: 'unknown', probe: {}, projectsStatus: 'unknown', roundsStatus: 'unknown' }
  const [tone, badge] = designBadge(d)
  return (
    <section aria-labelledby="farm-health-design" className="farm-health__design">
      <div className="farm-health__card-head">
        <h2 id="farm-health-design" className="farm-health__h2">
          Design steps
        </h2>
        <span className={`farm-health__design-badge farm-health__design-badge--${tone}`}>{badge}</span>
      </div>
      {d.status === 'ok' ? (
        <div className="farm-health__design-pair">
          <ToolCard design={d} />
          <ProbeCard design={d} />
        </div>
      ) : (
        <div className="farm-health__card">
          <p className="farm-health__empty">
            <strong>Design status unknown.</strong> Couldn&apos;t load the design-step state from the farm. The rest of
            Farm health is unaffected.
          </p>
        </div>
      )}
      <ProjectsCard design={d} />
      <RoundsCard design={d} onOpenItem={onOpenItem} />
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
          {/* HZ-802: items at an agent step with nothing running, and why. Hidden when there are none. */}
          {data.notDispatched?.length > 0 && (
            <>
              <h3 className="farm-health__h3">Not dispatched</h3>
              <table className="farm-health__table" data-testid="farm-health-not-dispatched">
                <tbody>
                  {data.notDispatched.map((n, i) => (
                    <tr key={`${n.itemId}-${i}`}>
                      <td>
                        <ItemLink id={n.itemId} onOpenItem={onOpenItem} />
                      </td>
                      <td>{n.step}</td>
                      <td className="farm-health__muted">{n.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
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
          <p className="farm-health__foot">{zombiesText(data.zombies)}</p>
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

      <DesignSteps design={data.design} onOpenItem={onOpenItem} />
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
