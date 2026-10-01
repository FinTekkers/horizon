import { useEffect, useState } from 'react'
import { STEPS } from '../../../domain/js/lifecycle.js'
import { listDefinitions, getDefinition, saveDefinition, effectivePrompt } from '../api'
import {
  CONCIERGE_MODEL_AGENT,
  CONFLICT_MODEL_AGENT,
  CONFLICT_STEP_KEY,
  DEFAULT_PERSONAS,
  MODELS,
  PRIMARY_PERSONA_AGENT,
  modelAgentForStep,
  personaSlotForFile,
  resolveModel,
} from '../domain/personas'
import { BackIcon } from './icons'

// The hierarchical agent-definitions library (HZ-9): Global (roles +
// personas, shared by every project) → Projects → Repos. Every layer is
// editable here; each save becomes a git commit server-side, so git history
// is the audit log. Rules compose onto the global personas — they never fork
// them — which is why the effective-prompt preview shows all layers merged.

const GROUPS = [
  { key: 'global', title: 'Global — every project', hint: 'Roles and personas. Editing here changes every agent on every project.' },
  { key: 'projects', title: 'Projects', hint: 'Cross-repo rules: service startup order, shared environment quirks.' },
  { key: 'repos', title: 'Repositories', hint: 'Build/run/test commands and constraints for one repo.' },
]

function DefinitionTree({ tree, selected, onSelect }) {
  return (
    <div className="defs__tree">
      {GROUPS.map((group) => (
        <div key={group.key} className="defs__group">
          <div className="defs__group-title" title={group.hint}>
            {group.title}
          </div>
          {(tree[group.key] || []).map((def) => {
            const id = `${def.kind}/${def.name}`
            const on = selected && `${selected.kind}/${selected.name}` === id
            return (
              <button
                key={id}
                className={`defs__item${on ? ' defs__item--on' : ''}`}
                onClick={() => onSelect(def)}
              >
                <span className="defs__item-kind">{def.kind}</span>
                {def.name}
                <span className="defs__item-bytes">{def.bytes} B</span>
              </button>
            )
          })}
          {(tree[group.key] || []).length === 0 && <div className="defs__empty">none yet</div>}
        </div>
      ))}
    </div>
  )
}

// HZ-192: the model each agent call runs on, resolved exactly as the farm's
// run_agent() does (persona override, then step override, then the agent's
// default) from domain/personas.json. Read-only: models are changed by a
// reviewed edit to that file, not here.
function modelRows() {
  return [
    ...STEPS.filter((step) => step.kind === 'agent').map((step) => {
      const agent = modelAgentForStep(step.agent)
      return { key: step.label, call: step.label, agent, model: resolveModel(agent, step.label) }
    }),
    { key: 'concierge', call: 'WhatsApp concierge', agent: CONCIERGE_MODEL_AGENT, model: resolveModel(CONCIERGE_MODEL_AGENT) },
    {
      key: CONFLICT_STEP_KEY,
      call: 'Merge-conflict resolution',
      agent: CONFLICT_MODEL_AGENT,
      model: resolveModel(CONFLICT_MODEL_AGENT, CONFLICT_STEP_KEY),
    },
  ]
}

function ModelsSection() {
  const personaOverrides = Object.entries(MODELS.personas)
  return (
    <details className="defs__models">
      <summary className="defs__group-title">Models — which Claude model each agent call uses</summary>
      <table aria-label="Effective model per step" style={{ borderCollapse: 'collapse', font: '500 13px var(--font-sans)' }}>
        <thead>
          <tr>
            <th align="left">Step</th>
            <th align="left">Agent</th>
            <th align="left">Model</th>
          </tr>
        </thead>
        <tbody>
          {modelRows().map((row) => (
            <tr key={row.key} data-testid={`model-row-${row.key}`}>
              <td>{row.call}</td>
              <td>{row.agent}</td>
              <td>
                <code>{row.model}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="defs__group-title">Persona overrides</div>
      {personaOverrides.length === 0 ? (
        <div className="defs__empty">None — every persona runs on its step's model.</div>
      ) : (
        <ul aria-label="Persona model overrides">
          {personaOverrides.map(([persona, model]) => (
            <li key={persona}>
              {persona} → <code>{model}</code>
            </li>
          ))}
        </ul>
      )}
      <div className="gh-note">
        Declared in <code>domain/personas.json</code>. When the farm host sets <code>FARM_MODEL_OVERRIDE</code>, it
        replaces every Claude model shown here; this page cannot see it. Muse-routed calls never receive a model.
      </div>
    </details>
  )
}

// Derive the preview context from the selection so the human sees the merged
// prompt this definition actually lands in.
function previewParams(selected) {
  const params = {
    role: 'eng_implement',
    agent: PRIMARY_PERSONA_AGENT,
    persona: DEFAULT_PERSONAS[PRIMARY_PERSONA_AGENT],
    project: 'FinTekkers',
  }
  if (!selected) return params
  // Persona files are agent-prefixed (HZ-125), so the selection names a file,
  // not a persona id — the agent has to travel with it or the preview composes
  // the default instead of what was clicked.
  if (selected.kind === 'persona') {
    const slot = personaSlotForFile(selected.name)
    if (slot) {
      params.agent = slot.agent
      params.persona = slot.persona
    }
  }
  if (selected.kind === 'role') params.role = selected.name
  if (selected.kind === 'project') params.project = selected.name
  if (selected.kind === 'repo') params.repo = selected.name.replace('__', '/')
  return params
}

export default function AgentDefinitionsPage({ onBack }) {
  const [tree, setTree] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [selected, setSelected] = useState(null)
  const [content, setContent] = useState('')
  const [filePath, setFilePath] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(null)
  const [preview, setPreview] = useState(null)

  const refreshTree = () =>
    listDefinitions()
      .then(setTree)
      .catch((err) => setLoadError(err.message))

  useEffect(() => {
    refreshTree()
  }, [])

  const select = async (def) => {
    setSelected(def)
    setError(null)
    setSaved(null)
    setPreview(null)
    setDirty(false)
    try {
      const full = await getDefinition(def.kind, def.name)
      setContent(full.content)
      setFilePath(full.path)
    } catch (err) {
      setContent('')
      setFilePath('')
      setError(err.message)
    }
  }

  const save = async () => {
    if (!selected || !dirty) return
    setBusy(true)
    setError(null)
    setSaved(null)
    try {
      const result = await saveDefinition(selected.kind, selected.name, content)
      setDirty(false)
      setSaved(result.unchanged ? 'No changes to save.' : `Saved — commit ${result.commit}${result.pushed ? ', pushed' : ' (local only)'}`)
      refreshTree()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const showPreview = async () => {
    setPreview(null)
    try {
      const result = await effectivePrompt(previewParams(selected))
      setPreview(result.prompt)
    } catch (err) {
      setError(err.message)
    }
  }

  const isGlobal = selected && (selected.kind === 'role' || selected.kind === 'persona')

  return (
    <div className="admin defs">
      <button className="tracker__back" onClick={onBack}>
        <BackIcon />
        Back to board
      </button>
      <div className="admin__title">Agent definitions</div>
      <div className="panel__subtitle">
        What every agent is told, layered: global role &amp; persona → project rules → repo rules. Later layers
        add to earlier ones — they never replace them. Saves are git commits; no secrets, use{' '}
        <code>$ENV_VAR</code> references.
      </div>

      <ModelsSection />

      {loadError && <div className="gh-error">{loadError}</div>}

      <div className="defs__layout">
        {tree ? <DefinitionTree tree={tree} selected={selected} onSelect={select} /> : !loadError && <div>Loading…</div>}

        <div className="defs__editor">
          {!selected && <div className="gh-note">Select a definition to view or edit it.</div>}
          {selected && (
            <>
              <div className="defs__editor-head">
                <strong>
                  {selected.kind}/{selected.name}
                </strong>
                {filePath && <span className="defs__path">{filePath}</span>}
              </div>
              {isGlobal && (
                <div className="defs__global-warning">
                  Global definition — edits here apply to <strong>every project</strong>.
                </div>
              )}
              <textarea
                className="defs__textarea"
                aria-label="Definition content"
                value={content}
                rows={20}
                onChange={(e) => {
                  setContent(e.target.value)
                  setDirty(true)
                  setSaved(null)
                }}
              />
              {error && <div className="gh-error">{error}</div>}
              {saved && <div className="gh-success">{saved}</div>}
              <div className="composer__actions">
                <button className="composer__cancel" onClick={showPreview}>
                  Preview effective prompt
                </button>
                <button
                  className="composer__submit"
                  style={{ background: 'var(--primary)' }}
                  onClick={save}
                  disabled={busy || !dirty}
                >
                  {busy ? 'Saving…' : 'Save (commits to git)'}
                </button>
              </div>
              {preview != null && (
                <div className="defs__preview">
                  <div className="defs__preview-title">Effective prompt — what an agent would receive</div>
                  <pre className="defs__preview-body">{preview}</pre>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
