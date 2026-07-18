import { useState, useSyncExternalStore } from 'react'
import * as api from './api'
import { awaitingGate } from './domain/lifecycle'
import TopBar from './components/TopBar'
import Board from './components/Board'
import Tracker from './components/Tracker'
import ApprovalsDrawer from './components/ApprovalsDrawer'
import ComposerModal from './components/ComposerModal'
import AdminPage from './components/AdminPage'
import NewItemModal from './components/NewItemModal'

const CLOSED_COMPOSER = { open: false, mode: null, itemId: null, phase: null, target: '' }

export default function App() {
  const items = useSyncExternalStore(api.subscribe, api.getItems)

  const [view, setView] = useState('board')
  const [selectedId, setSelectedId] = useState('BF-128')
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
    setView('board')
    setApprovalsOpen(false)
  }
  const toTracker = () => {
    setView('tracker')
    setApprovalsOpen(false)
  }
  const openItem = (id) => {
    setSelectedId(id)
    setView('tracker')
    setApprovalsOpen(false)
  }

  const openComposer = (mode, itemId, opts = {}) =>
    setComposer({ open: true, mode, itemId, phase: opts.phase ?? null, target: opts.target || '' })

  const submitComposer = (text) => {
    const { mode, itemId, phase, target } = composer
    if (itemId) {
      if (mode === 'reject') api.requestChanges(itemId, target, text)
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
          setView('admin')
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

      {view === 'admin' && <AdminPage sync={sync} projects={projects} onBack={toBoard} />}

      {view === 'tracker' && selected && (
        <Tracker
          item={selected}
          onBack={toBoard}
          onApprove={api.approveGate}
          onReject={(id, target) => openComposer('reject', id, { target })}
          onTogglePause={api.togglePause}
          onRestartPhase={(id, phase) => openComposer('restart', id, { phase })}
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
