import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import * as api from './api'
import { STEPS, awaitingGate, reworkTargets, defaultReworkTarget } from '../../domain/js/lifecycle.js'
import TopBar from './components/TopBar'
import BottomNav from './components/BottomNav'
import { MOBILE_QUERY, useMediaQuery } from './useMediaQuery'
import Board from './components/Board'
import Tracker from './components/Tracker'
import ApprovalsDrawer from './components/ApprovalsDrawer'
import ComposerModal from './components/ComposerModal'
import ConfirmGateDialog from './components/ConfirmGateDialog'
import ResolveConflictsDialog from './components/ResolveConflictsDialog'
import AdminPage from './components/AdminPage'
import AgentDefinitionsPage from './components/AgentDefinitionsPage'
import NewItemModal from './components/NewItemModal'
import LoginPage from './components/LoginPage'
import LegalPage, { LEGAL_DOCS } from './components/LegalPage'
import { gateActionBusy } from './domain/gateAction'

// HZ-188: what a finished server-side run (item.conflictRun) means to the
// resolve dialog, when this tab didn't make the request itself — a reload,
// another tab, or a click answered resolve_in_progress.
function resultFromConflictRun(run) {
  if (run?.state === 'resolved') return { ok: true, resolved: true }
  if (run?.state === 'escalated') return { ok: true, resolved: false, escalated: true, reason: run.reason }
  if (run?.state === 'failed') return { error: 'failed', reason: run.reason }
  return { error: 'resolve_in_progress', reason: 'another run was already using this item, so nothing new was started' }
}

// The phase the dialog actually shows: progress while this tab's request is
// pending or the server reports the item's run as running (so it survives a
// reload and shows a run another tab started), and the server's recorded
// outcome once a run this tab only watched has ended.
// A request that got no usable answer (a dropped connection, a proxy
// timeout page) watches the server the same way, but if the server never
// recorded a new run for it there is no outcome to show — only that the
// answer was lost.
function resolveDialogView(dialog, item, pending) {
  if (dialog.phase === 'done') return dialog
  if (pending || item?.conflictRun?.state === 'running') return { ...dialog, phase: 'running' }
  if (dialog.phase !== 'running') return dialog
  if (dialog.lostContact && (item?.conflictRun?.since ?? null) === dialog.runBefore) {
    return { ...dialog, phase: 'done', result: { error: 'no_response' } }
  }
  return { ...dialog, phase: 'done', result: resultFromConflictRun(item?.conflictRun) }
}

const CLOSED_COMPOSER = { open: false, mode: null, itemId: null, phase: null, target: '', stepOptions: [], defaultTargetLabel: null }

// Deep links: /  → board, /admin → admin, /definitions → agent definitions,
// /privacy and /terms → the public legal pages (no login required),
// /<item-id> → that item's tracker (case-insensitive, e.g. localhost:5173/hz-102).
// All relative to the vite base — '' at the dev root, '/horizon' when the
// production build is mounted under a subpath.
const PREFIX = import.meta.env.BASE_URL.replace(/\/$/, '')

function parsePath(pathname) {
  let path = pathname
  if (PREFIX && path.toLowerCase().startsWith(PREFIX.toLowerCase())) path = path.slice(PREFIX.length)
  const seg = decodeURIComponent(path.replace(/^\/+|\/+$/g, ''))
  if (!seg) return { view: 'board', id: null }
  if (seg.toLowerCase() === 'admin') return { view: 'admin', id: null }
  if (seg.toLowerCase() === 'definitions') return { view: 'definitions', id: null }
  if (Object.hasOwn(LEGAL_DOCS, seg.toLowerCase())) return { view: 'legal', id: seg.toLowerCase() }
  return { view: 'tracker', id: seg.toUpperCase() }
}

function navigate(path) {
  const full = PREFIX + path
  if (window.location.pathname !== full) window.history.pushState({}, '', full)
}

// Every page requires a login (HZ-21) — this is the app-level gate that
// replaces nginx's HTTP Basic Auth. `user` is undefined while the initial
// /api/auth/me check is in flight, null once it comes back unauthenticated.
export default function App() {
  // The legal pages are public: they render before (and regardless of) the
  // session check, so a signed-out visitor never sees the login page instead.
  const route = parsePath(window.location.pathname)
  if (route.view === 'legal') return <LegalPage doc={route.id} />
  return <GatedApp />
}

function GatedApp() {
  const [user, setUser] = useState(undefined)

  useEffect(() => {
    api.getCurrentUser().then(setUser)
  }, [])

  if (user === undefined) return null
  if (user === null) return <LoginPage onLoggedIn={setUser} />

  return (
    <AuthenticatedApp
      user={user}
      onLogout={() => {
        api.logout()
        setUser(null)
      }}
    />
  )
}

// The real app shell — only mounted once a session is confirmed, so its data
// layer (SSE subscribe, etc.) never fires against an unauthenticated session.
function AuthenticatedApp({ user, onLogout }) {
  const items = useSyncExternalStore(api.subscribe, api.getItems)

  const initial = parsePath(window.location.pathname)
  const [view, setView] = useState(initial.view)
  const [selectedId, setSelectedId] = useState(initial.id)
  const [approvalsOpen, setApprovalsOpen] = useState(false)
  const [composer, setComposer] = useState(CLOSED_COMPOSER)
  const [newItemOpen, setNewItemOpen] = useState(false)
  const [switchTarget, setSwitchTarget] = useState(null)
  // Plain Approve never used to pause for anything — with a cached gate PIN
  // it went straight to the server on click (HZ-38). This is the one gate it
  // must clear first: nothing here calls api.approveGate directly.
  const [confirmApprove, setConfirmApprove] = useState(null)
  // Resolve conflicts (HZ-188): the dialog, and the items this tab has a
  // request in flight for. The ref is the guard — two clicks (or a click and
  // an Enter) in the same tick both read the same stale state, but the second
  // sees the ref the first one set. The state copy is only for rendering.
  const [resolveDialog, setResolveDialog] = useState(null)
  const resolveInFlight = useRef(new Set())
  const [resolvePending, setResolvePending] = useState(() => new Set())
  // HZ-216: the same guard for an approve request this tab has in flight — it
  // covers the gap before the server's push says a gate action is running.
  const approveInFlight = useRef(new Set())
  const [approvePending, setApprovePending] = useState(() => new Set())

  const sync = api.getSync()
  const projects = api.getProjects()
  const activeProjectId = api.getActiveProjectId()
  const farm = api.getFarm()
  const activeProject = projects.find((p) => p.id === activeProjectId) || null
  const selected = items.find((it) => it.id === selectedId) || items[0]
  const pendingCount = items.filter(awaitingGate).length
  const isMobile = useMediaQuery(MOBILE_QUERY)
  const isResolving = (item) => !!item && (item.conflictRun?.state === 'running' || resolvePending.has(item.id))
  // HZ-216: HZ-188's isResolving, generalised to every long gate action —
  // whatever started it (this tab, another tab, WhatsApp), the server's
  // item.gateAction disables the gate's buttons until it finishes.
  const isGateBusy = (item) => !!item && (isResolving(item) || gateActionBusy(item) || approvePending.has(item.id))

  const openResolveDialog = (itemId, pr) => {
    const item = items.find((it) => it.id === itemId)
    setResolveDialog({ itemId, pr, phase: isResolving(item) ? 'running' : 'confirm', result: null })
  }
  const confirmResolve = () => {
    const d = resolveDialog
    if (!d || d.phase !== 'confirm' || resolveInFlight.current.has(d.itemId)) return
    resolveInFlight.current.add(d.itemId)
    setResolvePending(new Set(resolveInFlight.current))
    const runBefore = items.find((it) => it.id === d.itemId)?.conflictRun?.since ?? null
    setResolveDialog({ ...d, phase: 'running', runBefore })
    api
      .resolveConflicts(d.itemId)
      .catch(() => null)
      .then((result) => {
        resolveInFlight.current.delete(d.itemId)
        setResolvePending(new Set(resolveInFlight.current))
        // Another click or tab already owns the run: keep showing progress —
        // item.conflictRun says when it ends. No usable answer at all says
        // nothing about the run, so it is watched the same way rather than
        // reported as "nothing changed" while the server may still be working.
        const answered = result?.ok === true || typeof result?.error === 'string'
        const next = !answered
          ? { phase: 'running', lostContact: true }
          : result.error === 'resolve_in_progress'
            ? { phase: 'running' }
            : { phase: 'done', result }
        setResolveDialog((cur) => (cur && cur.itemId === d.itemId ? { ...cur, ...next } : cur))
      })
  }
  const resolveView =
    resolveDialog &&
    resolveDialogView(
      resolveDialog,
      items.find((it) => it.id === resolveDialog.itemId),
      resolvePending.has(resolveDialog.itemId),
    )

  const toBoard = () => {
    navigate('/')
    setView('board')
    setApprovalsOpen(false)
  }
  // Approving a gate only navigates away when it closed the item — earlier
  // gates leave the user in place since the next agent step starts immediately.
  const approveAndMaybeClose = async (itemId, notes) => {
    if (approveInFlight.current.has(itemId)) return
    approveInFlight.current.add(itemId)
    setApprovePending(new Set(approveInFlight.current))
    let result
    try {
      result = await api.approveGate(itemId, notes)
    } finally {
      approveInFlight.current.delete(itemId)
      setApprovePending(new Set(approveInFlight.current))
    }
    if (result?.closed) toBoard()
  }
  const toTracker = () => {
    if (selected) navigate(`/${selected.id.toLowerCase()}`)
    setView('tracker')
    setApprovalsOpen(false)
  }
  const openItem = (id) => {
    navigate(`/${id.toLowerCase()}`)
    setSelectedId(id)
    setView('tracker')
    setApprovalsOpen(false)
  }

  // Browser back/forward re-drives the view from the URL.
  useEffect(() => {
    const onPop = () => {
      const parsed = parsePath(window.location.pathname)
      setView(parsed.view)
      if (parsed.id) setSelectedId(parsed.id)
      setApprovalsOpen(false)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    document.title =
      view === 'tracker' && selected ? `${selected.id} · Horizon` : 'Horizon · Delivery Lifecycle'
  }, [view, selected])

  // Rejecting from a gate lets the human pick which earlier agent step the
  // item goes back to (HZ-51) — offered only when the item is actually
  // parked at a gate; picking one is optional, and submitting without a
  // choice reproduces today's nearest-preceding-step behavior exactly.
  const openComposer = (mode, itemId, opts = {}) => {
    const item = items.find((it) => it.id === itemId)
    const atGate = mode === 'reject' && item && STEPS[item.cursor]?.kind === 'gate'
    const stepOptions = atGate ? reworkTargets(item.cursor) : []
    const defaultTargetLabel = stepOptions.length ? STEPS[defaultReworkTarget(item.cursor)].label : null
    setComposer({ open: true, mode, itemId, phase: opts.phase ?? null, target: opts.target || '', stepOptions, defaultTargetLabel })
  }

  const requestApprove = (itemId, gateLabel) => setConfirmApprove({ itemId, gateLabel })

  const submitComposer = (text, targetStepIndex) => {
    const { mode, itemId, phase, target } = composer
    if (itemId) {
      // Both sides changed this line for unrelated reasons: main routes approve
      // through approveAndMaybeClose (HZ-62, return to the board once the
      // closing gate is approved) and this branch adds the chosen send-back
      // step to reject (HZ-51). They compose.
      if (mode === 'approve') approveAndMaybeClose(itemId, text)
      else if (mode === 'reject') api.requestChanges(itemId, target, text, targetStepIndex ?? null)
      else if (mode === 'restart') api.restartPhase(itemId, phase, text)
      else if (mode === 'abandon') api.abandonItem(itemId, text)
    }
    setComposer(CLOSED_COMPOSER)
  }

  return (
    <div className="app">
      <TopBar
        view={view}
        pendingCount={pendingCount}
        projects={projects}
        activeProjectId={activeProjectId}
        farm={farm}
        user={user}
        onLogout={onLogout}
        onRequestSwitch={setSwitchTarget}
        onBoard={toBoard}
        onTracker={toTracker}
        onOpenApprovals={() => setApprovalsOpen(true)}
        onOpenAdmin={() => {
          navigate('/admin')
          setView('admin')
          setApprovalsOpen(false)
        }}
        onOpenDefinitions={() => {
          navigate('/definitions')
          setView('definitions')
          setApprovalsOpen(false)
        }}
      />

      {isMobile && (
        <BottomNav
          view={view}
          pendingCount={pendingCount}
          onBoard={toBoard}
          onTracker={toTracker}
          onOpenApprovals={() => setApprovalsOpen(true)}
        />
      )}

      {farm?.status === 'restarting' && (
        <div className="farm-banner">
          The bot farm is restarting with <strong>{activeProject?.name || 'the selected project'}</strong>'s
          context — agents resume automatically when it's up.
        </div>
      )}

      {view === 'board' && (
        <Board
          items={items}
          onOpen={openItem}
          onApprove={requestApprove}
          onReject={(id, target) => openComposer('reject', id, { target })}
          onTogglePause={api.togglePause}
          onNewItem={() => setNewItemOpen(true)}
        />
      )}

      {view === 'admin' && (
        <AdminPage sync={sync} projects={projects} onBack={toBoard} />
      )}

      {view === 'definitions' && <AgentDefinitionsPage onBack={toBoard} />}

      {view === 'tracker' && selected && (
        <Tracker
          item={selected}
          onBack={toBoard}
          onApprove={requestApprove}
          onApproveWithComments={(id, target) => openComposer('approve', id, { target })}
          onReject={(id, target) => openComposer('reject', id, { target })}
          onResolveConflicts={openResolveDialog}
          resolving={isResolving(selected)}
          gateBusy={isGateBusy(selected)}
          onForwardToAccept={(id) => api.forwardToAccept(id)}
          onTogglePause={api.togglePause}
          onRestartPhase={(id, phase) => openComposer('restart', id, { phase })}
          onSetPersona={api.setPersona}
          onAbandon={(id) => openComposer('abandon', id)}
        />
      )}

      {resolveView && (
        <ResolveConflictsDialog
          itemId={resolveView.itemId}
          pr={resolveView.pr}
          phase={resolveView.phase}
          result={resolveView.result}
          onConfirm={confirmResolve}
          onClose={() => setResolveDialog(null)}
        />
      )}

      {approvalsOpen && (
        <ApprovalsDrawer
          items={items}
          onClose={() => setApprovalsOpen(false)}
          onOpenItem={openItem}
          onApprove={requestApprove}
          onReject={(id, target) => openComposer('reject', id, { target })}
        />
      )}

      {composer.open && (
        <ComposerModal composer={composer} onSubmit={submitComposer} onCancel={() => setComposer(CLOSED_COMPOSER)} />
      )}

      {confirmApprove && (
        <ConfirmGateDialog
          itemId={confirmApprove.itemId}
          gateLabel={confirmApprove.gateLabel}
          onConfirm={() => {
            approveAndMaybeClose(confirmApprove.itemId)
            setConfirmApprove(null)
          }}
          onCancel={() => setConfirmApprove(null)}
        />
      )}

      {newItemOpen && <NewItemModal activeProject={activeProject} onClose={() => setNewItemOpen(false)} />}

      {switchTarget && (
        <div className="composer">
          <div className="composer__scrim" onClick={() => setSwitchTarget(null)} />
          <div className="composer__panel">
            <div className="composer__title">Switch bot farm to {switchTarget.name}?</div>
            <div className="composer__sub">
              The bot farm runs with one project's context at a time. Switching shuts down the current agents and
              restarts them with {switchTarget.name}'s context — <strong>this can take a few minutes</strong>.
              In-flight agent steps are re-queued and resume automatically; work in{' '}
              {activeProject?.name || 'the current project'} pauses until you switch back.
            </div>
            <div className="composer__actions">
              <button className="composer__cancel" onClick={() => setSwitchTarget(null)}>
                Cancel
              </button>
              <button
                className="composer__submit"
                style={{ background: 'var(--primary)' }}
                onClick={() => {
                  api.activateProject(switchTarget.id).catch((err) => console.error(err))
                  setSwitchTarget(null)
                  setView('board')
                }}
              >
                Switch & restart farm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
