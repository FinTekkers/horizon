import { useRef, useState } from 'react'
import { EXECUTE_STEP_INDEX, isAbandoned, isClosed } from '../../../domain/js/lifecycle.js'
import { jobLogUrl } from '../api'
import { useClockTick } from '../useClockTick'

// HZ-407: the Execute step card's live job — each approved command with its
// status, elapsed time against the plan's budget, the log's last lines and
// Stop run / Resume. The view is the server's stepOutputs[Execute].job, pushed
// down the item's own stream; nothing here fetches. Log lines and command text
// arrive redacted and render as React text only. HO-843: Patch edits the
// first command that did not pass and sends the plan back for re-approval.

const COMMAND_STATUSES = new Set(['done', 'running', 'pending', 'stopped'])

// Why Stop run or Resume was refused, keyed by the route's error code.
const JOB_ERRORS = {
  no_job: 'The job is no longer running.',
  already_running: 'The job is already running.',
  nothing_to_resume: 'There is nothing to resume.',
  plan_changed: 'The run plan changed since it was approved — send it back to Run plan and approve it again.',
}

// HO-843: why a command patch was refused, keyed by the route's error code.
// A literal secret names the shapes found, never the text.
const PATCH_ERRORS = {
  bad_patch: 'Enter the command on one line.',
  no_change: 'That is the command already approved.',
  not_patchable: 'The command cannot be patched now — the job is running or the plan is not approved.',
  stale_step: 'The item moved on — reload to see where it is.',
  run_plan_changed: 'The run plan changed since this page loaded — reload and try again.',
  not_a_task: 'Only a Task run plan can be patched.',
}

function patchError(err) {
  if (err?.message === 'literal_secret') {
    const shapes = Array.isArray(err.shapes) && err.shapes.length ? ` (${err.shapes.join(', ')})` : ''
    return `That looks like a literal secret${shapes} — name secrets only as references like $GITHUB_TOKEN.`
  }
  return Object.hasOwn(PATCH_ERRORS, err?.message ?? '') ? PATCH_ERRORS[err.message] : 'That did not go through — try again.'
}

// HO-843: the command to offer Patch on — the first that did not pass.
function firstUnpassed(commands) {
  return (commands || []).findIndex((c) => !(c.status === 'done' && c.exit_code === 0))
}

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

// The view's elapsed seconds, moved on locally while the job runs, so the
// count keeps up between frames (a display clock, not a fetch).
function liveElapsed(job) {
  const at = Date.parse(job.updatedAt ?? '')
  if (job.status !== 'running' || Number.isNaN(at)) return job.elapsedS ?? 0
  return (job.elapsedS ?? 0) + Math.max(0, (Date.now() - at) / 1000)
}

export default function JobPanel({ item, job, onStop, onResume, onPatch }) {
  const running = job.status === 'running'
  useClockTick(1000, running)
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // HO-843: the inline one-line editor of the command being patched.
  const [patching, setPatching] = useState(null)
  const resumable =
    ['stopped', 'budget_exceeded'].includes(job.status) && item.paused && item.cursor === EXECUTE_STEP_INDEX && !isClosed(item) && !isAbandoned(item)
  // HO-843: Patch, on the first command that did not pass, while no job runs
  // at Execute on an approved plan. The patched command needs the PIN again
  // at Approve the run; every other command keeps its approval.
  const patchIndex =
    onPatch && !running && item.cursor === EXECUTE_STEP_INDEX && item.approvedPlanHash && !isClosed(item) && !isAbandoned(item)
      ? firstUnpassed(job.commands)
      : -1

  const submitPatch = (event) => {
    event.preventDefault()
    if (inFlight.current || !patching) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    new Promise((resolve) => resolve(onPatch(item.id, { index: patching.index, command: patching.text })))
      .then(
        () => {
          setPatching(null)
          return null
        },
        (err) => patchError(err),
      )
      .then((message) => {
        inFlight.current = false
        setBusy(false)
        setError(message)
      })
  }

  const act = (fn) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    new Promise((resolve) => resolve(fn(item.id)))
      .then(
        () => null,
        (err) => JOB_ERRORS[err?.message] || 'That did not go through — try again.',
      )
      .then((message) => {
        inFlight.current = false
        setBusy(false)
        setError(message)
      })
  }

  const elapsed = liveElapsed(job)
  const over = job.budgetS > 0 && elapsed > job.budgetS
  return (
    <div className="job-panel" data-testid="job-panel">
      <ol className="job-panel__commands">
        {(job.commands || []).map((c, i) => {
          const status = COMMAND_STATUSES.has(c.status) ? c.status : 'pending'
          return (
            <li key={i} className="job-panel__command">
              <span className={`job-chip job-chip--${status}`}>{status}</span>
              <code className="job-panel__command-text">{c.command}</code>
              {status === 'done' && c.exit_code != null && c.exit_code !== 0 && (
                <span className="job-panel__exit">exit {c.exit_code}</span>
              )}
              {i === patchIndex && patching?.index !== i && (
                <button
                  type="button"
                  className="btn-gate-reject job-panel__patch"
                  disabled={busy}
                  onClick={() => {
                    setError(null)
                    setPatching({ index: i, text: c.command })
                  }}
                >
                  Patch
                </button>
              )}
              {patching?.index === i && (
                <form className="job-panel__patch-form" onSubmit={submitPatch}>
                  <label className="job-panel__patch-label">
                    {`New command ${i + 1}`}
                    <input
                      className="job-panel__patch-input"
                      type="text"
                      value={patching.text}
                      maxLength={2000}
                      onChange={(e) => setPatching({ index: i, text: e.target.value })}
                    />
                  </label>
                  <button type="submit" className="btn-gate-approve" disabled={busy || !patching.text.trim()} aria-busy={busy || undefined}>
                    Patch command
                  </button>
                  <button type="button" className="btn-gate-reject" disabled={busy} onClick={() => setPatching(null)}>
                    Cancel
                  </button>
                </form>
              )}
            </li>
          )
        })}
      </ol>
      <div className={`job-panel__elapsed${over ? ' job-panel__elapsed--over' : ''}`} data-testid="job-elapsed">
        {clock(elapsed)} of {clock(job.budgetS ?? 0)} budget
      </div>
      {job.logTail?.length > 0 && (
        <pre className="job-panel__log" data-testid="job-log">
          {job.logTail.join('\n')}
        </pre>
      )}
      <div className="step-card__actions">
        <a className="step-card__output-link" href={jobLogUrl(item.id)} target="_blank" rel="noopener noreferrer">
          Full log ↗
        </a>
        {running && onStop && (
          <button className="btn-gate-reject" disabled={busy} aria-busy={busy || undefined} onClick={() => act(onStop)}>
            Stop run
          </button>
        )}
        {resumable && onResume && (
          <button className="btn-gate-approve" disabled={busy} aria-busy={busy || undefined} onClick={() => act(onResume)}>
            Resume
          </button>
        )}
        {error && <span role="alert">{error}</span>}
      </div>
    </div>
  )
}
