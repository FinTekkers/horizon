import { useState } from 'react'
import { createItem } from '../api'
// HZ-135: the picker's options and its initial value are domain/priorities.json's,
// not a fourth hand-typed copy. The ORDER matters and comes from there too — the
// segmented control renders the array left-to-right, severity first.
import { PRIORITIES, DEFAULT_PRIORITY } from '../../../domain/js/priorities.js'
// HZ-382: the kind cards and their copy are domain/steps.json's kinds.
import { ITEM_KIND_INFO } from '../../../domain/js/lifecycle.js'

// The intake form doubles as the spec for "work the bot farm can process":
// a clear outcome and a measurable success criterion are required before an
// item enters the lifecycle; everything else the Plan-phase agents refine.

// HZ-208: `projects` is every ENABLED project (the caller filters); new work
// can go into any of them. Picking a project selects its first repository.
export default function NewItemModal({ projects = [], defaultProjectId = null, onClose, onCreated }) {
  const [projectId, setProjectId] = useState(
    () => (projects.find((p) => p.id === defaultProjectId) || projects[0])?.id ?? null,
  )
  const project = projects.find((p) => p.id === projectId) || null
  const repos = project?.repos || []
  const [title, setTitle] = useState('')
  const [outcome, setOutcome] = useState('')
  const [metric, setMetric] = useState('')
  const [guardrails, setGuardrails] = useState('')
  const [priority, setPriority] = useState(DEFAULT_PRIORITY)
  const [kind, setKind] = useState('change')
  const [repo, setRepo] = useState(repos[0]?.repo ?? null)
  const chooseProject = (p) => {
    setProjectId(p.id)
    setRepo(p.repos?.[0]?.repo ?? null)
  }
  const [errors, setErrors] = useState({})
  const [serverError, setServerError] = useState(null)
  const [busy, setBusy] = useState(false)

  const validate = () => {
    const next = {}
    if (title.trim().length < 3) next.title = 'Give the work a short, specific name.'
    if (outcome.trim().length < 10) {
      next.outcome = 'Describe the outcome — the bots can’t plan work they can’t picture.'
    }
    if (metric.trim().length < 5) {
      next.metric = 'A measurable success criterion is required — it becomes the acceptance bar at the review gate.'
    }
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const submit = async () => {
    if (!validate()) return
    setBusy(true)
    setServerError(null)
    try {
      const created = await createItem({
        title: title.trim(),
        outcome: outcome.trim(),
        metric: metric.trim(),
        guardrails: guardrails.trim(),
        priority,
        kind,
        ...(repo ? { repo } : {}),
      })
      onCreated?.(created)
      onClose()
    } catch (err) {
      setServerError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="composer">
      <div className="composer__scrim" onClick={onClose} />
      <div className="composer__panel composer__panel--wide">
        <div className="composer__title">New work item{project ? ` · ${project.name}` : ''}</div>
        <div className="composer__sub">
          {repo
            ? `Creates an issue in ${repo} — GitHub stays the source of truth.`
            : 'Creates a local demo item (connect a repo in Admin to create real issues).'}
        </div>

        {projects.length > 1 && (
          <div className="field">
            <div className="field__label">Project</div>
            <div className="prio-seg" style={{ flexWrap: 'wrap', maxWidth: '100%' }}>
              {projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={projectId === p.id}
                  className={`prio-seg__btn${projectId === p.id ? ' prio-seg__btn--on' : ''}`}
                  onClick={() => chooseProject(p)}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {repos.length > 1 && (
          <div className="field">
            <div className="field__label">Repository</div>
            <div className="prio-seg">
              {repos.map((r) => (
                <button
                  key={r.repo}
                  className={`prio-seg__btn${repo === r.repo ? ' prio-seg__btn--on' : ''}`}
                  onClick={() => setRepo(r.repo)}
                >
                  {r.repo.split('/')[1]}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="field">
          <div className="field__label">Title · required</div>
          <input
            className="field__input"
            placeholder="One line naming the work, e.g. “Risk-limit breach dashboard”"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
          {errors.title && <div className="field__error">{errors.title}</div>}
        </div>

        <div className="field">
          <div className="field__label" id="new-item-kind-label">Kind</div>
          <div className="kind-cards" role="radiogroup" aria-labelledby="new-item-kind-label">
            {ITEM_KIND_INFO.map((info) => (
              <label key={info.kind} className={`kind-card${kind === info.kind ? ' kind-card--on' : ''}`}>
                <input
                  type="radio"
                  name="kind"
                  value={info.kind}
                  checked={kind === info.kind}
                  onChange={() => setKind(info.kind)}
                />
                <span>
                  <span className="kind-card__name">{info.label}</span>
                  <span className="kind-card__desc">{info.description}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="field">
          <div className="field__label">Outcome · required</div>
          <div className="field__help">
            High-level description of what “done” looks like, from the user's point of view. The PM agent turns
            this into the plan the first human gate approves.
          </div>
          <textarea
            className="field__input field__textarea"
            placeholder="e.g. Risk managers get a live view of limit utilization across every desk…"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
          />
          {errors.outcome && <div className="field__error">{errors.outcome}</div>}
        </div>

        <div className="field">
          <div className="field__label">Success metric · required</div>
          <div className="field__help">
            How we'll objectively verify it worked — a number, a threshold, or a checkable condition. Vague
            metrics stall at the review gate.
          </div>
          <textarea
            className="field__input field__textarea field__textarea--short"
            placeholder="e.g. Limit breaches acknowledged in < 2 min (from 14 min today)"
            value={metric}
            onChange={(e) => setMetric(e.target.value)}
          />
          {errors.metric && <div className="field__error">{errors.metric}</div>}
        </div>

        <div className="field">
          <div className="field__label">Guardrails · optional</div>
          <div className="field__help">
            Constraints the bots must not cross, beyond the defaults (unit/integration/e2e tests, linters and
            quality checks must always pass).
          </div>
          <textarea
            className="field__input field__textarea field__textarea--short"
            placeholder="e.g. Read-only — no position mutation. No PII in telemetry."
            value={guardrails}
            onChange={(e) => setGuardrails(e.target.value)}
          />
        </div>

        <div className="field">
          <div className="field__label">Priority</div>
          <div className="prio-seg">
            {PRIORITIES.map((p) => (
              <button
                key={p}
                className={`prio-seg__btn${priority === p ? ' prio-seg__btn--on' : ''}`}
                onClick={() => setPriority(p)}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        {serverError && <div className="gh-error">{serverError}</div>}

        <div className="composer__actions">
          <button className="composer__cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="composer__submit" style={{ background: 'var(--primary)' }} onClick={submit} disabled={busy}>
            {busy ? 'Creating…' : 'Create work item'}
          </button>
        </div>
      </div>
    </div>
  )
}
