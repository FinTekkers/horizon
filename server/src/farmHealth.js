// HZ-563: Farm health — the farm's and the box's health for an admin.
//
// Read-only by construction. A background loop (startFarmHealth) collects one
// snapshot every FARM_HEALTH_POLL_MS while an admin is looking, and caches
// it; GET /api/admin/farm-health
// only reads that cache (getFarmHealth), so a page left open in any number of
// tabs never adds a systemctl call or a farmd request. The only things a
// collection does are file reads under /proc and /sys, a statfs of '/', one
// `systemctl is-active <units>` (deployDryRun's execProbe: no shell, no sudo,
// a timeout, and a minimal env) and one GET of farmd's /farm/status.
//
// What reaches the browser is decided by toPublic, an allowlist: it copies
// named keys only and never spreads an input object, so farmd's `sessions`,
// its `error` text, environment values, command lines and a deploy's failure
// text cannot leak through.
//
// The one source for "the farm is not running" is this collector's own
// /farm/status fetch (farmStatusOf below), not the orchestrator's farm state,
// so the page and its menu dot always agree with each other.

import fs from 'node:fs/promises'
import os from 'node:os'
import { FARM_HEALTH_POLL_MS, FARM_URL } from './config.js'
import { execProbe } from './deployDryRun.js'
import { farmFetch } from './orchestrator.js'
import * as store from './store.js'
import { msOf, sqlTime } from './sqlTime.js'
import { STEPS } from '../../domain/js/lifecycle.js'

// The services ~/post-migration-check.sh checks, in its order. `name` and
// `detail` are the design's labels; `unit` is what systemctl is asked about.
export const UNITS = Object.freeze([
  { unit: 'horizon-server', name: 'horizon-server', detail: ':3001' },
  { unit: 'horizon-farm', name: 'horizon-farm', detail: ':4100' },
  { unit: 'nginx', name: 'nginx', detail: null },
  { unit: 'postgresql@16-main', name: 'postgresql', detail: ':5432' },
  { unit: 'fintekkers-ui', name: 'fintekkers-ui', detail: ':3002' },
  { unit: 'fintekkers-ledger', name: 'ledger', detail: 'gRPC :8082' },
  { unit: 'fintekkers-valuation', name: 'valuation', detail: 'gRPC :8080' },
  { unit: 'fintekkers-broker', name: 'broker', detail: ':8083' },
  { unit: 'fintekkers-price', name: 'price', detail: ':8085' },
  { unit: 'whatsapp-bridge', name: 'whatsapp-bridge', detail: null },
  { unit: 'shoreward-contact', name: 'shoreward-contact', detail: ':3003' },
  { unit: 'earlyoom', name: 'earlyoom', detail: null },
])

// systemctl's own state words. Anything else (or a missing line) reads 'unknown'.
const UNIT_STATES = new Set(['active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading', 'unknown'])
const SYSTEMCTL_TIMEOUT_MS = 3000
const FARM_STATUS_TIMEOUT_MS = 3000
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000
// farmd's state words; a farm we could not reach (or no FARM_URL) is 'not_running'.
const FARM_STATES = new Set(['running', 'starting', 'stopped', 'error', 'not_running'])

export const THRESHOLDS = Object.freeze({
  diskRedPct: 90,
  diskAmberPct: 75,
  loadPerVcpu: 1.25,
  memAvailableMinPct: 15,
})

const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null)
const pct = (part, whole) => (finite(part) != null && finite(whole) > 0 ? (part / whole) * 100 : null)
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10)

// ---- the rules ----

// inputs: { farm: {status}, services: [{name, up}], capacity: {agents: {busy, limit}},
//           waitingCount, box: {load1, vcpus, memAvailablePct, diskUsedPct} }
// Red rules run first, so red wins; the reason is the first rule that matched.
export function deriveHealth(inputs) {
  const farmStatus = inputs?.farm?.status
  const services = Array.isArray(inputs?.services) ? inputs.services : []
  const agents = inputs?.capacity?.agents || {}
  const waiting = finite(inputs?.waitingCount) || 0
  const box = inputs?.box || {}
  const disk = finite(box.diskUsedPct)
  const load1 = finite(box.load1)
  const vcpus = finite(box.vcpus)
  const mem = finite(box.memAvailablePct)

  if (farmStatus !== 'running') {
    const detail = farmStatus && farmStatus !== 'not_running' ? ` (${farmStatus})` : ''
    return { state: 'red', reason: `Farm is not running${detail}` }
  }
  const down = services.filter((s) => !s.up)
  if (down.length === 1) return { state: 'red', reason: `${down[0].name} is down` }
  if (down.length > 1) return { state: 'red', reason: `${down.length} services are down: ${down.map((s) => s.name).join(', ')}` }
  if (disk != null && disk > THRESHOLDS.diskRedPct) {
    return { state: 'red', reason: `Disk is ${Math.round(disk)}% used, above ${THRESHOLDS.diskRedPct}%` }
  }

  if (finite(agents.limit) > 0 && finite(agents.busy) >= agents.limit) {
    return { state: 'amber', reason: `All ${agents.limit} agent slots are busy` }
  }
  if (waiting > 0) return { state: 'amber', reason: `${waiting} ${waiting === 1 ? 'step is' : 'steps are'} waiting for a slot` }
  if (load1 != null && vcpus > 0 && load1 > THRESHOLDS.loadPerVcpu * vcpus) {
    return { state: 'amber', reason: `CPU load is ${round1(load1 / vcpus)}× the ${vcpus} vCPUs over the last minute` }
  }
  if (mem != null && mem < THRESHOLDS.memAvailableMinPct) {
    return { state: 'amber', reason: `Only ${Math.round(mem)}% of memory is available` }
  }
  if (disk != null && disk > THRESHOLDS.diskAmberPct) {
    return { state: 'amber', reason: `Disk is ${Math.round(disk)}% used, above ${THRESHOLDS.diskAmberPct}%` }
  }
  return { state: 'green', reason: 'All services up, slots free and box figures normal' }
}

// ---- readers (pure parsers over injected text) ----

export function parseLoadavg(text) {
  const parts = String(text || '').trim().split(/\s+/).slice(0, 3).map(Number)
  return parts.length === 3 && parts.every(Number.isFinite) ? parts : null
}

// The kB figures this page uses from /proc/meminfo, in bytes. Other lines are ignored.
export function parseMeminfo(text) {
  const want = { MemTotal: 'memTotal', MemAvailable: 'memAvailable', SwapTotal: 'swapTotal', SwapFree: 'swapFree' }
  const out = { memTotal: null, memAvailable: null, swapTotal: null, swapFree: null }
  for (const line of String(text || '').split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB\s*$/.exec(line)
    if (m && Object.hasOwn(want, m[1])) out[want[m[1]]] = Number(m[2]) * 1024
  }
  return out
}

// `systemctl is-active a b c` prints one state per unit, in order, and exits
// non-zero when any is not active — so stdout is read whatever the exit code.
export function parseIsActive(stdout, units = UNITS) {
  const lines = String(stdout || '').split('\n').map((l) => l.trim())
  return units.map((u, i) => {
    const state = UNIT_STATES.has(lines[i]) ? lines[i] : 'unknown'
    return { unit: u.unit, name: u.name, detail: u.detail, state, up: state === 'active' }
  })
}

// farmd's /farm/status, reduced to the farm status this page decides on.
function farmStatusOf(raw) {
  const status = typeof raw?.status === 'string' && FARM_STATES.has(raw.status) ? raw.status : 'not_running'
  return { status, since: typeof raw?.since === 'string' ? raw.since : null }
}

function slot(raw) {
  return { busy: finite(raw?.busy) ?? 0, limit: finite(raw?.limit) ?? 0 }
}

// Where a step runs, by the step's own flag: the PM lane, the server itself, or an agent slot.
function slotOfStep(stepIndex) {
  const runsIn = STEPS[stepIndex]?.runsIn
  if (runsIn === 'pm') return 'pm'
  if (runsIn === 'server') return 'server'
  return 'agent'
}

// HZ-574: farmd's caller names, as Farm health shows them. Any other value is null.
const CALLERS = Object.freeze({ step_agent: 'implement', conflict_resolver: 'conflict resolver', premerge: 'pre-merge' })

// farmd's checks.holders, one row per held slot, by slot. Only the named
// fields are read: farmd's pid and anything else never reach the snapshot.
function checkHoldersOf(raw) {
  const out = []
  for (const h of Array.isArray(raw) ? raw : []) {
    if (!h || !Number.isInteger(h.slot)) continue
    const since = finite(h.since)
    const started = since != null ? new Date(since * 1000) : null
    out.push({
      slot: h.slot,
      itemId: typeof h.item_id === 'string' ? h.item_id : null,
      runId: h.run_id != null ? String(h.run_id) : null,
      caller: typeof h.caller === 'string' && Object.hasOwn(CALLERS, h.caller) ? CALLERS[h.caller] : null,
      label: typeof h.label === 'string' ? h.label : null,
      // An out-of-range time reads null rather than throwing in the collector.
      startedAt: started && Number.isFinite(started.getTime()) ? started.toISOString() : null,
    })
  }
  return out.sort((a, b) => a.slot - b.slot)
}

const isoOfSql = (sql) => {
  const ms = typeof sql === 'string' ? msOf(sql) : NaN
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

// ---- one collection ----

export const defaultDeps = {
  readFile: (path) => fs.readFile(path, 'utf8'),
  statfs: (path) => fs.statfs(path),
  execProbe,
  farmFetch: (path, body, opts) => farmFetch(path, body, opts),
  farmConfigured: () => Boolean(FARM_URL),
  vcpus: () => os.availableParallelism(),
  uptime: () => os.uptime(),
  now: () => Date.now(),
  activeRuns: () => store.listActiveRunsWithState(),
  liveDeploysSince: (sinceSql) => store.listLiveDeploysSince(sinceSql),
  serverBootedAt: () => store.BOOTED_AT,
}

const settle = (promise) => Promise.resolve().then(() => promise).then((v) => v, () => null)

export async function collectOnce(deps = defaultDeps) {
  const now = deps.now()
  const [loadText, memText, machineText, disk, probe, farmRaw] = await Promise.all([
    settle(deps.readFile('/proc/loadavg')),
    settle(deps.readFile('/proc/meminfo')),
    settle(deps.readFile('/sys/class/dmi/id/product_name')),
    settle(deps.statfs('/')),
    settle(deps.execProbe('systemctl', ['is-active', ...UNITS.map((u) => u.unit)], SYSTEMCTL_TIMEOUT_MS)),
    deps.farmConfigured() ? settle(deps.farmFetch('/farm/status', undefined, { timeoutMs: FARM_STATUS_TIMEOUT_MS })) : null,
  ])

  const load = parseLoadavg(loadText)
  const mem = parseMeminfo(memText)
  const diskTotal = disk ? finite(disk.blocks * disk.bsize) : null
  const diskFree = disk ? finite(disk.bfree * disk.bsize) : null
  const diskAvail = disk ? finite(disk.bavail * disk.bsize) : null
  // df's Use%: used over what a non-root user could fill.
  const diskUsed = diskTotal != null && diskFree != null ? diskTotal - diskFree : null
  const machine = typeof machineText === 'string' ? machineText.trim() : ''
  const box = {
    load,
    vcpus: finite(deps.vcpus()),
    machine: /^[\w.-]{1,40}$/.test(machine) ? machine : null,
    memTotalBytes: mem.memTotal,
    memAvailableBytes: mem.memAvailable,
    memAvailablePct: round1(pct(mem.memAvailable, mem.memTotal)),
    diskTotalBytes: diskTotal,
    diskAvailBytes: diskAvail,
    diskUsedPct: round1(diskUsed != null && diskAvail != null ? pct(diskUsed, diskUsed + diskAvail) : null),
    swapTotalBytes: mem.swapTotal,
    swapUsedPct: round1(mem.swapTotal > 0 ? pct(mem.swapTotal - mem.swapFree, mem.swapTotal) : mem.swapTotal === 0 ? 0 : null),
    uptimeS: finite(deps.uptime()),
  }

  const farm = farmStatusOf(farmRaw)
  // horizon-farm is a Type=oneshot launcher that starts farmd in tmux, so its
  // systemd state says nothing about farmd: that row follows /farm/status.
  const services = parseIsActive(probe?.stdout).map((s) =>
    s.unit === 'horizon-farm' ? { ...s, state: farm.status, up: farm.status === 'running' } : s,
  )
  const checksRaw = farmRaw?.checks || {}
  const capacity = {
    agents: slot(farmRaw?.agents),
    express: slot(farmRaw?.express),
    pm: slot(farmRaw?.pm_agents),
    checks: slot(checksRaw),
  }

  // Running and waiting rows: Horizon's active runs with the farm's cached
  // queued/running state, plus runs farmd lists as waiting for a check slot.
  const checkWaiters = Array.isArray(checksRaw.waiting) ? checksRaw.waiting : []
  const checkWaitByRun = new Map()
  for (const w of checkWaiters) {
    if (w && w.run_id != null) checkWaitByRun.set(String(w.run_id), { waited: finite(w.waited_s), caller: w.caller })
  }
  const running = []
  const waiting = []
  const activeRuns = deps.activeRuns() || []
  for (const run of activeRuns) {
    const row = {
      itemId: run.item_id,
      step: STEPS[run.step_index]?.label || null,
      slot: slotOfStep(run.step_index),
      startedAt: isoOfSql(run.started_at),
    }
    const runId = String(run.id)
    if (checkWaitByRun.has(runId)) {
      const { waited, caller } = checkWaitByRun.get(runId)
      // HZ-574: an agent step's own checks run inside its agent session, so
      // while it waits for a check slot it still holds its agent slot. A
      // pre-merge or conflict-resolver check runs elsewhere and holds none.
      const holdsAgentSlot = row.slot === 'agent' && (caller == null || caller === 'step_agent')
      waiting.push({
        ...row,
        slot: 'check',
        lane: row.slot,
        holdsAgentSlot,
        startedAt: waited != null ? new Date(now - waited * 1000).toISOString() : row.startedAt,
      })
    } else if (run.state === 'queued') {
      waiting.push(row)
    } else {
      running.push(row)
    }
  }
  // HZ-585: a pre-merge run at Accept has no step run of its own, so its
  // check-slot wait matches no row above; list it here. One whose run_id did
  // match a row above is already listed.
  const activeIds = new Set(activeRuns.map((run) => String(run.id)))
  for (const w of checkWaiters) {
    if (!w || w.caller !== 'premerge' || (w.run_id != null && activeIds.has(String(w.run_id)))) continue
    const waited = finite(w.waited_s)
    waiting.push({
      itemId: typeof w.item_id === 'string' ? w.item_id : null,
      step: 'Pre-merge checks',
      slot: 'check',
      lane: null,
      holdsAgentSlot: false,
      startedAt: waited != null ? new Date(now - waited * 1000).toISOString() : null,
    })
  }
  const waitingCount = waiting.length
  const agentsWaiting = waiting.filter((w) => w.slot === 'agent').length
  const pmWaiting = waiting.filter((w) => w.slot === 'pm').length
  const checksWaiting = Math.max(checkWaiters.length, waiting.filter((w) => w.slot === 'check').length)
  capacity.agents.waiting = agentsWaiting
  capacity.pm.waiting = pmWaiting
  capacity.checks.waiting = checksWaiting
  const checkHolders = checkHoldersOf(checksRaw.holders)

  // Recent: deploys that went live, farm (re)starts and this server's own boot, last 24 h.
  const sinceMs = now - RECENT_WINDOW_MS
  const recent = []
  for (const d of deps.liveDeploysSince(sqlTime(sinceMs)) || []) {
    recent.push({ kind: 'deploy', target: d.target, tag: d.tag, at: isoOfSql(d.live_at) })
  }
  if (farm.since && Date.parse(farm.since) >= sinceMs) recent.push({ kind: 'farm_restart', target: null, tag: null, at: farm.since })
  const booted = deps.serverBootedAt()
  if (booted && Date.parse(booted) >= sinceMs) recent.push({ kind: 'server_restart', target: null, tag: null, at: booted })
  recent.sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0))

  const health = deriveHealth({
    farm,
    services,
    capacity,
    waitingCount,
    box: { load1: load?.[0], vcpus: box.vcpus, memAvailablePct: box.memAvailablePct, diskUsedPct: box.diskUsedPct },
  })

  return {
    ...health,
    collectedAt: new Date(now).toISOString(),
    farm,
    capacity,
    waitingCount,
    running,
    waiting,
    checkHolders,
    box,
    services,
    recent,
  }
}

// ---- what the browser may see ----

const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null)
const num = (v) => finite(v)
const pubSlot = (s) => ({ busy: num(s?.busy) ?? 0, limit: num(s?.limit) ?? 0, waiting: num(s?.waiting) ?? 0 })
const pubRow = (r) => ({
  itemId: str(r?.itemId, 40),
  step: str(r?.step),
  slot: str(r?.slot, 20),
  startedAt: str(r?.startedAt, 40),
  holdsAgentSlot: r?.holdsAgentSlot === true,
})
const pubHolder = (h) => ({
  slot: Number.isInteger(h?.slot) ? h.slot : null,
  itemId: str(h?.itemId, 40),
  runId: str(h?.runId, 40),
  caller: str(h?.caller, 40),
  label: str(h?.label, 60),
  startedAt: str(h?.startedAt, 40),
})

export function toPublic(snapshot) {
  const s = snapshot || {}
  const box = s.box || {}
  const capacity = s.capacity || {}
  return {
    state: ['green', 'amber', 'red'].includes(s.state) ? s.state : 'red',
    reason: str(s.reason) || '',
    collectedAt: str(s.collectedAt, 40),
    farm: { status: str(s.farm?.status, 20), since: str(s.farm?.since, 40) },
    capacity: {
      agents: pubSlot(capacity.agents),
      express: pubSlot(capacity.express),
      pm: pubSlot(capacity.pm),
      checks: pubSlot(capacity.checks),
    },
    waitingCount: num(s.waitingCount) ?? 0,
    running: (s.running || []).map(pubRow),
    waiting: (s.waiting || []).map(pubRow),
    checkHolders: (s.checkHolders || []).map(pubHolder),
    box: {
      load: Array.isArray(box.load) ? box.load.slice(0, 3).map(num) : null,
      vcpus: num(box.vcpus),
      machine: str(box.machine, 40),
      memTotalBytes: num(box.memTotalBytes),
      memAvailableBytes: num(box.memAvailableBytes),
      memAvailablePct: num(box.memAvailablePct),
      diskTotalBytes: num(box.diskTotalBytes),
      diskAvailBytes: num(box.diskAvailBytes),
      diskUsedPct: num(box.diskUsedPct),
      swapTotalBytes: num(box.swapTotalBytes),
      swapUsedPct: num(box.swapUsedPct),
      uptimeS: num(box.uptimeS),
    },
    services: (s.services || []).map((v) => ({
      name: str(v?.name, 60),
      unit: str(v?.unit, 60),
      detail: str(v?.detail, 40),
      state: str(v?.state, 20),
      up: v?.up === true,
    })),
    recent: (s.recent || []).map((e) => ({ kind: str(e?.kind, 20), target: str(e?.target, 60), tag: str(e?.tag, 80), at: str(e?.at, 40) })),
  }
}

// ---- the cache and its loop ----

let cached = null
// Set by startFarmHealth; null in tests that only build the app.
let loop = null

// The cached snapshot. Also the demand signal: an admin reading it keeps the
// background loop running (and wakes it when idle), but the read itself never
// collects — the next collection still happens on the loop's own timer.
export function getFarmHealth() {
  if (loop) loop.want()
  return cached
}

// Collects once and caches the result. Exported for tests, which pass deps.
export async function refreshFarmHealth(deps = defaultDeps) {
  cached = await collectOnce(deps)
  return cached
}

// Arms the loop. It collects only while someone is looking: from the first
// read of the cache, every FARM_HEALTH_POLL_MS, until no read has come for
// idleMs. So a server nobody opens Farm health on never runs systemctl or
// asks farmd for anything (farm/tests/test_step_survives_restart.py holds a
// booted server to that). The next run is only scheduled once this one
// settles, so two collections never overlap.
export function startFarmHealth({ log, deps = defaultDeps, intervalMs = FARM_HEALTH_POLL_MS, idleMs = 60_000 } = {}) {
  let timer = null
  let running = false
  let stopped = false
  let wantedUntil = 0
  const tick = async () => {
    if (stopped || deps.now() > wantedUntil) {
      running = false
      return
    }
    try {
      await refreshFarmHealth(deps)
    } catch (err) {
      log?.warn(`Farm health collection failed: ${err.message}`)
    }
    if (stopped) return
    timer = setTimeout(tick, intervalMs)
    timer.unref?.()
  }
  const self = {
    want() {
      wantedUntil = deps.now() + idleMs
      if (running || stopped) return
      running = true
      // Deferred, so the read that woke the loop returns before any collection starts.
      timer = setTimeout(tick, 0)
      timer.unref?.()
    },
  }
  loop = self
  return () => {
    stopped = true
    clearTimeout(timer)
    if (loop === self) loop = null
  }
}
