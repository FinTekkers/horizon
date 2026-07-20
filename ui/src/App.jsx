import { useEffect, useState, useSyncExternalStore } from 'react'
import * as api from './api'
import { awaitingGate } from './domain/lifecycle'
import TopBar from './components/TopBar'
import Board from './components/Board'
import Tracker from './components/Tracker'
import ApprovalsDrawer from './components/ApprovalsDrawer'
import ComposerModal from './components/ComposerModal'
import AdminPage from './components/AdminPage'
import AgentDefinitionsPage from './components/AgentDefinitionsPage'
import NewItemModal from './components/NewItemModal'

const CLOSED_COMPOSER = { open: false, mode: null, itemId: null, phase: null, target: '' }

// Deep links: /  → board, /admin → admin, /definitions → agent definitions,
// /<item-id> → that item's tracker (case-insensitive, e.g. localhost:5173/hz-102).
function parsePath(pathname) {
  const seg = decodeURIComponent(pathname.replace(/^\/+|\/+$/g, ''))
  if (!seg) return { view: 'board', id: null }
  if (seg.toLowerCase() === 'admin') return { view: 'admin', id: null }
  if (seg.toLowerCase() === 'definitions') return { view: 'definitions', id: null }
  return { view: 'tracker', id: seg.toUpperCase() }
}

function navigate(path) {
  if (window.location.pathname !== path) window.history.pushState({}, '', path)
}

export default function App() {
  const items = useSyncExternalStore(api.subscribe, api.getItems)

  const initial = parsePath(window.location.pathname)
  const [view, setView] = useState(initial.view)
  const [selectedId, setSelectedId] = useState(initial.id)
  const [approvalsOpen, setApprovalsOpen] = useState(false)
  const [composer, setComposer] = useState(CLOSED_COMPOSER)
  const [newItemOpen, setNewItemOpen] = useState(false)
  const [switchTarget, setSwitchTarget] = useState(null)

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

  const openComposer = (mode, itemId, opts = {}) =>
    setComposer({ open: true, mode, itemId, phase: opts.phase ?? null, target: opts.target || '' })

  const submitComposer = (text) => {
    const { mode, itemId, phase, target } = composer
    if (itemId) {
      if (mode === 'approve') api.approveGate(itemId, text)
      else if (mode === 'reject') api.requestChanges(itemId, target, text)
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
          onApprove={api.approveGate}
          onReject={(id, target) => openComposer('reject', id, { target })}
          onTogglePause={api.togglePause}
          onNewItem={() => setNewItemOpen(true)}
        />
      )}

      {view === 'admin' && (
        <AdminPage sync={sync} security={api.getSecurity()} projects={projects} onBack={toBoard} />
      )}

      {view === 'definitions' && <AgentDefinitionsPage onBack={toBoard} />}

      {view === 'tracker' && selected && (
        <Tracker
          item={selected}
          onBack={toBoard}
          onApprove={api.approveGate}
          onApproveWithComments={(id, target) => openComposer('approve', id, { target })}
          onReject={(id, target) => openComposer('reject', id, { target })}
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
          onApprove={api.approveGate}
          onReject={(id, target) => openComposer('reject', id, { target })}
        />
      )}

      {composer.open && (
        <ComposerModal composer={composer} onSubmit={submitComposer} onCancel={() => setComposer(CLOSED_COMPOSER)} />
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
                style={{ background: '#2E6CB2' }}
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
