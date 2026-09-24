import { useEffect, useState, useSyncExternalStore } from 'react'
import * as api from './api'
import { STEPS, awaitingGate, reworkTargets, defaultReworkTarget } from './domain/lifecycle'
import TopBar from './components/TopBar'
import Board from './components/Board'
import Tracker from './components/Tracker'
import ApprovalsDrawer from './components/ApprovalsDrawer'
import ComposerModal from './components/ComposerModal'
import ConfirmGateDialog from './components/ConfirmGateDialog'
import AdminPage from './components/AdminPage'
import AgentDefinitionsPage from './components/AgentDefinitionsPage'
import NewItemModal from './components/NewItemModal'
import LoginPage from './components/LoginPage'

const CLOSED_COMPOSER = { open: false, mode: null, itemId: null, phase: null, target: '', stepOptions: [], defaultTargetLabel: null }

// Deep links: /  → board, /admin → admin, /definitions → agent definitions,
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

  const sync = api.getSync()
  const projects = api.getProjects()
  const activeProjectId = api.getActiveProjectId()
  const farm = api.getFarm()
  const activeProject = projects.find((p) => p.id === activeProjectId) || null
  const selected = items.find((it) => it.id === selectedId) || items[0]
  const pendingCount = items.filter(awaitingGate).length

  const toBoard = () => {
    navigate('/')
    setView('board')
    setApprovalsOpen(false)
  }
  // Approving a gate only navigates away when it closed the item — earlier
  // gates leave the user in place since the next agent step starts immediately.
  const approveAndMaybeClose = async (itemId, notes) => {
    const result = await api.approveGate(itemId, notes)
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
          onResolveConflicts={(id, pr) =>
            api.requestChanges(
              id,
              'Accept the code',
              `PR #${pr} has merge conflicts — merge current main into the branch and resolve the conflicts, keeping main's changes intact`,
            )
          }
          onTogglePause={api.togglePause}
          onRestartPhase={(id, phase) => openComposer('restart', id, { phase })}
          onSetPersona={api.setPersona}
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
