import { Fragment, useState } from 'react'
import { setProjectEnabled, setProjectAutopilot, setProjectDefinitionsEnabled, setProjectStepProvider } from '../../api'
import { ITEM_KINDS, STEPS, itemKindInfo } from '../../../../domain/js/lifecycle.js'

// HZ-208: a project's dispatch on/off switch. Every flip, both ways, is
// confirmed here; HZ-704: the PIN dialog asks for the gate PIN only when the
// session is not PIN-verified. The switch shows the server's state from the
// snapshot — never an optimistic guess — so a refused change leaves it
// exactly as it was.
export function ProjectEnabledToggle({ project }) {
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const next = !project.enabled
  const verb = next ? 'Enable' : 'Disable'

  const cancel = () => {
    setAsking(false)
    setError(null)
  }

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await setProjectEnabled(project.id, next)
      setAsking(false)
    } catch (err) {
      setError(err.message === 'pin_needed' ? 'Gate PIN needed — nothing was saved' : err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="project-enabled">
        <span>{project.enabled ? 'Enabled' : 'Disabled'}</span>
        <button
          type="button"
          role="switch"
          aria-checked={!!project.enabled}
          aria-label={`${project.name} enabled`}
          className="theme-switch"
          onClick={() => (asking ? cancel() : setAsking(true))}
        >
          <span className="theme-switch__thumb" />
        </button>
      </div>
      {asking && (
        <form className="project-block__add" style={{ flexBasis: '100%' }} onSubmit={submit}>
          <button type="submit" className="composer__submit" style={{ background: 'var(--primary)' }} disabled={busy}>
            {busy ? `${verb.replace(/e$/, '')}ing…` : verb}
          </button>
          <button type="button" className="composer__cancel" onClick={cancel}>
            Cancel
          </button>
        </form>
      )}
      {error && <div className="gh-error" style={{ flexBasis: '100%' }}>{error}</div>}
    </>
  )
}

// HZ-535: the switch for the project's own definitions
// (farm/projects/<slug>/personas.json), next to Autopilot. The box shows the
// server's value: a click asks to save, and only a saved change moves it.
export function ProjectDefinitions({ project }) {
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const enabled = project.definitionsEnabled !== false
  const next = enabled ? 'off' : 'on'

  const cancel = () => {
    setAsking(false)
    setError(null)
  }

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await setProjectDefinitionsEnabled(project.id, !enabled)
      setAsking(false)
    } catch (err) {
      setError(err.message === 'pin_needed' ? 'Gate PIN needed — nothing was saved' : err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="project-definitions" style={{ marginBottom: 8 }}>
      <label className="project-autopilot__row">
        <input
          type="checkbox"
          aria-label={`${project.name} project definitions`}
          checked={enabled}
          onChange={() => (asking ? cancel() : setAsking(true))}
        />
        <span>Project definitions</span>
      </label>
      {asking && (
        <form className="project-block__add" onSubmit={submit}>
          <button type="submit" className="composer__submit" style={{ background: 'var(--primary)' }} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="composer__cancel" onClick={cancel}>
            Cancel
          </button>
        </form>
      )}
      {error && <div className="gh-error">{error}</div>}
    </div>
  )
}

// HZ-270: a project's Autopilot mode. Picking a mode asks to save, exactly
// like ProjectEnabledToggle; the select always shows the server's value, so a
// refused change leaves it as it was. The last few changes show
// underneath, from the project_event audit trail.
const AUTOPILOT_MODES = ['off', 'shadow', 'on']

export function ProjectAutopilot({ project }) {
  const [pending, setPending] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const cancel = () => {
    setPending(null)
    setError(null)
  }

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await setProjectAutopilot(project.id, pending)
      setPending(null)
    } catch (err) {
      setError(err.message === 'pin_needed' ? 'Gate PIN needed — nothing was saved' : err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="project-autopilot">
      <label className="project-autopilot__row">
        <span>Autopilot</span>
        <select
          className="field__input"
          aria-label={`${project.name} Autopilot`}
          value={project.autopilot || 'off'}
          onChange={(e) => (e.target.value === (project.autopilot || 'off') ? cancel() : setPending(e.target.value))}
        >
          {AUTOPILOT_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
      </label>
      {pending && (
        <form className="project-block__add" onSubmit={submit}>
          <button type="submit" className="composer__submit" style={{ background: 'var(--primary)' }} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="composer__cancel" onClick={cancel}>
            Cancel
          </button>
        </form>
      )}
      {error && <div className="gh-error">{error}</div>}
      {(project.autopilotEvents || []).length > 0 && (
        <ul className="gh-note project-autopilot__history" aria-label={`${project.name} Autopilot history`}>
          {project.autopilotEvents.map((ev) => (
            <li key={`${ev.at}-${ev.old}-${ev.new}`}>
              {ev.old} → {ev.new} · {ev.who} · {ev.at}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// HZ-370: the project's default "Runs on" per step, for items with no choice
// of their own — steps 0-2 run before anyone opens a new item. Only steps
// domain/steps.json marks providerOverrideEligible get a select, so deploy
// has none (and the server refuses it anyway). Saving works like Autopilot;
// the select shows the server's value, so a refused change leaves it as it
// was.
const STEP_PROVIDER_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'claude', label: 'Claude' },
  { value: 'muse', label: 'Muse' },
]
const PROVIDER_ELIGIBLE_STEPS = STEPS.map((step, index) => ({ ...step, index })).filter(
  (step) => step.kind === 'agent' && step.providerOverrideEligible,
)
// HZ-413: a Task's steps 0-2 take a default too, under their own heading. The
// two kinds' first steps share a label, so a Task select's label names the kind;
// the change selects keep their labels as they were.
const PROVIDER_STEP_GROUPS = ITEM_KINDS.map((kind) => ({
  kind,
  steps: PROVIDER_ELIGIBLE_STEPS.filter((step) => (step.itemKind ?? 'change') === kind),
})).filter((group) => group.steps.length > 0)
const providerSelectName = (project, step) =>
  step.itemKind ? `${project.name} ${itemKindInfo(step.itemKind).label} ${step.label}` : `${project.name} ${step.label}`

export function ProjectStepProviders({ project }) {
  const [pending, setPending] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const savedFor = (index) => project.providerDefaults?.[index] ?? 'default'

  const cancel = () => {
    setPending(null)
    setError(null)
  }

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await setProjectStepProvider(project.id, pending.index, pending.provider)
      setPending(null)
    } catch (err) {
      setError(err.message === 'pin_needed' ? 'Gate PIN needed — nothing was saved' : err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="project-autopilot">
      <div>Runs on</div>
      {PROVIDER_STEP_GROUPS.map((group) => (
        <Fragment key={group.kind}>
          {group.steps[0].itemKind && <div>{itemKindInfo(group.kind).label} steps</div>}
          {group.steps.map((step) => (
            <label key={step.index} className="project-autopilot__row">
              <span>{step.label}</span>
              <select
                className="field__input"
                aria-label={`${providerSelectName(project, step)} Runs on`}
                value={savedFor(step.index)}
                onChange={(e) =>
                  e.target.value === savedFor(step.index) ? cancel() : setPending({ index: step.index, provider: e.target.value })
                }
              >
                {STEP_PROVIDER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </Fragment>
      ))}
      {pending && (
        <form className="project-block__add" onSubmit={submit}>
          <button type="submit" className="composer__submit" style={{ background: 'var(--primary)' }} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="composer__cancel" onClick={cancel}>
            Cancel
          </button>
        </form>
      )}
      {error && <div className="gh-error">{error}</div>}
    </div>
  )
}
