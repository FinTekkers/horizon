import { useState } from 'react'
import { createItem } from '../api'

// The intake form doubles as the spec for "work the bot farm can process":
// a clear outcome and a measurable success criterion are required before an
// item enters the lifecycle; everything else the Plan-phase agents refine.

const PRIORITIES = ['Critical', 'High', 'Medium', 'Low']

export default function NewItemModal({ activeProject, onClose, onCreated }) {
  const repos = activeProject?.repos || []
  const [title, setTitle] = useState('')
  const [outcome, setOutcome] = useState('')
  const [metric, setMetric] = useState('')
  const [guardrails, setGuardrails] = useState('')
  const [priority, setPriority] = useState('Medium')
  const [repo, setRepo] = useState(repos[0]?.repo ?? null)
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
      await createItem({
        title: title.trim(),
        outcome: outcome.trim(),
        metric: metric.trim(),
        guardrails: guardrails.trim(),
        priority,
        ...(repo ? { repo } : {}),
      })
      onCreated?.()
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
        <div className="composer__title">New work item{activeProject ? ` · ${activeProject.name}` : ''}</div>
        <div className="composer__sub">
          {repo
            ? `Creates an issue in ${repo} — GitHub stays the source of truth.`
            : 'Creates a local demo item (connect a repo in Admin to create real issues).'}
        </div>

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
          <button className="composer__submit" style={{ background: '#2E6CB2' }} onClick={submit} disabled={busy}>
            {busy ? 'Creating…' : 'Create work item'}
          </button>
        </div>
      </div>
    </div>
  )
}
