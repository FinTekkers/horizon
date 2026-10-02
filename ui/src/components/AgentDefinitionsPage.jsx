import { useEffect, useState } from 'react'
import { STEPS } from '../../../domain/js/lifecycle.js'
import {
  listDefinitions,
  getDefinition,
  saveDefinition,
  effectivePrompt,
  listRuleTargets,
  listRuleVersions,
  saveRule,
  restoreRule,
} from '../api'
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
// editable here. Global saves become git commits server-side, so git history
// is the audit log; project and repo rules save as versions in Horizon's DB
// (HZ-246) over the farm/rules/*.md defaults, each save and restore gated by
// the gate PIN. Rules compose onto the global personas — they never fork
// them — which is why the effective-prompt preview shows all layers merged.

const GROUPS = [
  { key: 'global', title: 'Global — every project', hint: 'Roles and personas. Editing here changes every agent on every project.' },
  { key: 'projects', title: 'Projects', hint: 'Cross-repo rules: service startup order, shared environment quirks.' },
  { key: 'repos', title: 'Repositories', hint: 'Build/run/test commands and constraints for one repo.' },
]

const isRulesKind = (kind) => kind === 'project' || kind === 'repo'

function itemNote(def) {
  if (!isRulesKind(def.kind)) return `${def.bytes} B`
  if (def.versions > 0) return `${def.versions} saved`
  return def.file ? 'file' : 'no rules'
}

// A rules target from GET /api/rules/targets, shaped like a definition.
const rulesEntry = (target) => ({ kind: target.scope, name: target.key, label: target.label, file: target.file, versions: target.versions })

// What agents are served, in words (null served_version = the file default).
function servingNote(rules) {
  if (rules.served_version != null) return `Agents get saved version ${rules.served_version}.`
  if (rules.default.exists) return `Agents get the file default (${rules.default.path}).`
  return 'No rules — no file and no saved version.'
}

function servedContent(rules) {
  const served = rules.versions.find((v) => v.version === rules.served_version)
  return served ? served.content : rules.default.content
}

function RuleVersions({ rules, onRestore, busy }) {
  if (rules.versions.length === 0) return <div className="defs__empty">No saved versions yet.</div>
  return (
    <ul className="defs__versions" aria-label="Saved versions">
      {rules.versions.map((v) => (
        <li key={v.id} data-testid={`rule-version-${v.version}`}>
          <strong>v{v.version}</strong> · {v.actor} · {v.created_at}
          {v.restored_from != null && ` · restored from v${v.restored_from}`}
          {v.version === rules.served_version && ' · serving'}
          {!v.verified && <span className="gh-error"> · tampered — not served</span>}{' '}
          <button
            type="button"
            className="composer__cancel"
            aria-label={`Restore version ${v.version}`}
            disabled={busy || !v.verified}
            onClick={() => onRestore(v.version)}
          >
            Restore
          </button>
        </li>
      ))}
    </ul>
  )
}

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
                <span className="defs__item-bytes">{itemNote(def)}</span>
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
  const [rules, setRules] = useState(null)
  const [pin, setPin] = useState('')

  const refreshTree = () =>
    Promise.all([listDefinitions(), listRuleTargets()])
      .then(([defs, targets]) =>
        setTree({ global: defs.global, projects: targets.projects.map(rulesEntry), repos: targets.repos.map(rulesEntry) }),
      )
      .catch((err) => setLoadError(err.message))

  const loadRules = async (def) => {
    const data = await listRuleVersions(def.kind, def.name)
    setRules(data)
    setContent(servedContent(data))
    setFilePath(data.default.path || '')
    setDirty(false)
  }

  useEffect(() => {
    refreshTree()
  }, [])

  const select = async (def) => {
    setSelected(def)
    setError(null)
    setSaved(null)
    setPreview(null)
    setDirty(false)
    setRules(null)
    try {
      if (isRulesKind(def.kind)) return await loadRules(def)
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
      if (isRulesKind(selected.kind)) {
        const result = await saveRule(selected.kind, selected.name, content, pin)
        await loadRules(selected)
        setSaved(`Saved as version ${result.version.version}`)
        refreshTree()
        return
      }
      const result = await saveDefinition(selected.kind, selected.name, content)
      setDirty(false)
      setSaved(result.unchanged ? 'No changes to save.' : `Saved — commit ${result.commit}${result.pushed ? ', pushed' : ' (local only)'}`)
      refreshTree()
    } catch (err) {
      setError(err.status === 401 ? 'Gate PIN incorrect' : err.message)
    } finally {
      setPin('')
      setBusy(false)
    }
  }

  const restore = async (version) => {
    if (!selected) return
    setBusy(true)
    setError(null)
    setSaved(null)
    try {
      const result = await restoreRule(selected.kind, selected.name, version, pin)
      await loadRules(selected)
      setSaved(`Restored version ${version} as version ${result.version.version}`)
      refreshTree()
    } catch (err) {
      setError(err.status === 401 ? 'Gate PIN incorrect' : err.message)
    } finally {
      setPin('')
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
  const isRules = selected && isRulesKind(selected.kind)

  return (
    <div className="admin defs">
      <button className="tracker__back" onClick={onBack}>
        <BackIcon />
        Back to board
      </button>
      <div className="admin__title">Agent definitions</div>
      <div className="panel__subtitle">
        What every agent is told, layered: global role &amp; persona → project rules → repo rules. Later layers
        add to earlier ones — they never replace them. Global saves are git commits; project and repo rules save
        as versions in Horizon's database, over the files in git. No secrets, use <code>$ENV_VAR</code> references.
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
              {isRules && rules && <div className="gh-note">{servingNote(rules)}</div>}
              {error && <div className="gh-error">{error}</div>}
              {saved && <div className="gh-success">{saved}</div>}
              <div className="composer__actions">
                <button className="composer__cancel" onClick={showPreview}>
                  Preview effective prompt
                </button>
                {isRules && (
                  <input
                    className="field__input"
                    type="password"
                    autoComplete="off"
                    aria-label="Gate PIN to save or restore rules"
                    placeholder="Gate PIN"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                  />
                )}
                <button
                  className="composer__submit"
                  style={{ background: 'var(--primary)' }}
                  onClick={save}
                  disabled={busy || !dirty || (isRules && !pin)}
                >
                  {busy ? 'Saving…' : isRules ? 'Save new version' : 'Save (commits to git)'}
                </button>
              </div>
              {isRules && rules && (
                <div className="defs__preview">
                  <div className="defs__preview-title">Saved versions — restoring copies one into a new version</div>
                  <RuleVersions rules={rules} onRestore={restore} busy={busy || !pin} />
                </div>
              )}
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
