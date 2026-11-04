import { Fragment, useState } from 'react'
import { saveRepoChecks, saveRepoMarks, saveRepoTestEnvFile, getRepoCheckDefaults } from '../../api'

const CHECK_SLOTS = [
  { key: 'install', label: 'Install' },
  { key: 'test', label: 'Test' },
  { key: 'lint', label: 'Lint' },
  { key: 'e2e', label: 'E2E' },
  // HZ-505: runs only when the branch's .horizon/screenshots.json is valid,
  // and never counts as "checks configured" on its own.
  { key: 'screenshots', label: 'Screenshots' },
]

const savedChecks = (repoConn) =>
  Object.fromEntries(CHECK_SLOTS.map(({ key }) => [key, repoConn.checks?.[key] ?? '']))

// HZ-750: the slots a repo may opt into a fix round's targeted run, which
// re-runs only last round's failed tests (in HORIZON_FAILED_TESTS) first.
export const TARGETABLE_SLOTS = ['test', 'e2e']
export const TARGETED_LABEL = 'On a fix round, re-run only the failed tests first'

// One opt-in box under a test slot's command. Disabled, and shown unticked,
// while the slot has no command: the server drops such a slot anyway.
export function TargetedBox({ slotLabel, repo, command, checked, onChange }) {
  const hasCommand = !!command.trim()
  return (
    <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input
        type="checkbox"
        aria-label={`${slotLabel}: ${TARGETED_LABEL} (${repo})`}
        checked={hasCommand && checked}
        disabled={!hasCommand}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="field__label" style={{ margin: 0 }}>
        {TARGETED_LABEL}
      </span>
    </label>
  )
}

// The opted-in slots to send: only those with a command, in slot order.
export const targetedToSend = (targeted, values) =>
  TARGETABLE_SLOTS.filter((slot) => targeted.includes(slot) && values[slot]?.trim())

// HZ-304: a repo's 'no checks' or 'no deploy' mark. Every flip is confirmed,
// exactly like ProjectEnabledToggle. The switch shows the server's value from
// the snapshot, so a refused change leaves it as it was.
function RepoMarkToggle({ projectId, repo, mark, label, on }) {
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const verb = on ? 'Clear' : 'Set'

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
      await saveRepoMarks(projectId, repo, { [mark]: !on })
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
        <span>{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={!!on}
          aria-label={`${label} for ${repo}`}
          className="theme-switch"
          onClick={() => (asking ? cancel() : setAsking(true))}
        >
          <span className="theme-switch__thumb" />
        </button>
      </div>
      {asking && (
        <form className="project-block__add" style={{ flexBasis: '100%' }} onSubmit={submit}>
          <button type="submit" className="composer__submit" style={{ background: 'var(--primary)' }} disabled={busy}>
            {busy ? 'Saving…' : verb}
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

// HZ-304: the repo's two marks, and a plain-words warning while it has no
// check commands and no 'no checks' mark. Read from the snapshot, so it shows
// what the next dispatch will see.
export function RepoMarks({ projectId, repoConn }) {
  const configured = CHECK_SLOTS.some(({ key }) => key !== 'screenshots' && repoConn.checks?.[key])
  const noChecks = !!repoConn.marks?.noChecks
  return (
    <div className="repo-marks">
      <RepoMarkToggle projectId={projectId} repo={repoConn.repo} mark="noChecks" label="No checks" on={noChecks} />
      <RepoMarkToggle
        projectId={projectId}
        repo={repoConn.repo}
        mark="noDeploy"
        label="No deploy"
        on={!!repoConn.marks?.noDeploy}
      />
      {!configured && !noChecks && (
        <div className="gh-error repo-marks__warning" role="status">
          no checks configured: items in this repo will fail at implement
        </div>
      )}
    </div>
  )
}

// HZ-245: the commands the farm's checks run for this repo, in implement and
// pre-merge. Saving is gate-PIN protected (saveRepoChecks): these commands
// judge every agent's work. The detected
// defaults load only when the block is opened, so a down farm never slows
// the page.
export function RepoChecks({ projectId, repoConn }) {
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState(() => savedChecks(repoConn))
  const [targeted, setTargeted] = useState(() => repoConn.targeted ?? [])
  const [defaults, setDefaults] = useState(null)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  const toggle = () => {
    if (!open && defaults === null) {
      getRepoCheckDefaults(projectId, repoConn.repo)
        .then((result) => setDefaults(result.defaults || {}))
        .catch(() => setDefaults({}))
    }
    if (!open) {
      setValues(savedChecks(repoConn))
      setTargeted(repoConn.targeted ?? [])
    }
    setOpen(!open)
  }

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const result = await saveRepoChecks(projectId, repoConn.repo, values, targetedToSend(targeted, values))
      setValues(Object.fromEntries(CHECK_SLOTS.map(({ key }) => [key, result.checks?.[key] ?? ''])))
      setTargeted(result.targeted ?? [])
      setSaved(true)
    } catch (err) {
      setError(err.message === 'pin_needed' ? 'Gate PIN needed — nothing was saved' : err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="repo-checks">
      <button type="button" className="repo-checks__toggle" aria-expanded={open} onClick={toggle}>
        {open ? '▾' : '▸'} Check commands
      </button>
      {open && (
        <form className="repo-checks__form" onSubmit={submit}>
          <div className="gh-note">
            The greyed hints are suggestions detected on the hub clone (a fresh workspace may differ); a hint never
            runs until you type it in and save. Only the filled boxes run, in this order; empty ones are skipped,
            never auto-filled. With every box empty, implement fails unless the repo is marked 'no checks'. Each runs as <code>sh -c</code>, so a missing program fails the check rather than being
            skipped. One command per line: each line runs and is timed on its own, in order, and the first failure
            stops the run. Only the first install line is cached, so put the dependency install there. Commands
            are read when a step starts, so an edit applies from the next run. Do not put tokens or secrets in
            commands.
          </div>
          {CHECK_SLOTS.map(({ key, label }) => (
            <Fragment key={key}>
              <label className="field">
                <span className="field__label">{label}</span>
                <textarea
                  className="field__input"
                  aria-label={`${label} command for ${repoConn.repo}`}
                  placeholder={defaults?.[key] || ''}
                  rows={Math.max(1, values[key].split('\n').length)}
                  maxLength={2000}
                  value={values[key]}
                  onChange={(e) => {
                    setSaved(false)
                    setValues({ ...values, [key]: e.target.value })
                  }}
                />
              </label>
              {TARGETABLE_SLOTS.includes(key) && (
                <TargetedBox
                  slotLabel={label}
                  repo={repoConn.repo}
                  command={values[key]}
                  checked={targeted.includes(key)}
                  onChange={(on) => {
                    setSaved(false)
                    setTargeted(on ? [...targeted, key] : targeted.filter((slot) => slot !== key))
                  }}
                />
              )}
            </Fragment>
          ))}
          <div className="gh-note">
            {TARGETED_LABEL}: on a fix round the farm runs that slot alone first, with last round's failed tests in{' '}
            <code>HORIZON_FAILED_TESTS</code> (one <code>file</code> or <code>file:line</code> per line). If they still
            fail, the next fix starts at once; if they pass, every check runs as usual. Tick it only once the slot's
            command reads that variable.
          </div>
          <div className="project-block__add">
            <button type="submit" className="composer__submit" style={{ background: 'var(--primary)' }} disabled={busy}>
              {busy ? 'Saving…' : 'Save commands'}
            </button>
          </div>
          {saved && <div className="gh-success">Check commands saved.</div>}
          {error && <div className="gh-error">{error}</div>}
        </form>
      )}
      {open && <RepoTestEnvFile projectId={projectId} repoConn={repoConn} />}
    </div>
  )
}

// HZ-494: the host path of a file of test-login variables that the farm loads
// into this repo's test/e2e checks and deploy smoke check. Saving is gate-PIN
// protected, like the commands above. Horizon stores the path
// only; the farm reads the file at run time, so no value reaches this page.
function RepoTestEnvFile({ projectId, repoConn }) {
  const [value, setValue] = useState(repoConn.testEnvFile ?? '')
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const result = await saveRepoTestEnvFile(projectId, repoConn.repo, value.trim())
      setValue(result.testEnvFile ?? '')
      setSaved(true)
    } catch (err) {
      setError(err.message === 'pin_needed' ? 'Gate PIN needed — nothing was saved' : err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="repo-checks__form" onSubmit={submit}>
      <label className="field">
        <span className="field__label">Test credentials env file</span>
        <input
          className="field__input"
          aria-label={`Test credentials env file for ${repoConn.repo}`}
          placeholder="/etc/fintekkers/ui-e2e.env"
          maxLength={500}
          value={value}
          onChange={(e) => {
            setSaved(false)
            setValue(e.target.value)
          }}
        />
      </label>
      <div className="gh-note">
        Optional. An absolute path on the farm host to a file of <code>NAME=value</code> lines, e.g. a test
        login. Horizon stores the path only; the farm reads the file each time this repo's test and e2e checks
        and its deploy smoke check run, and passes the values to those commands only. Agents see the variable
        names, never the values. Every value is masked as <code>[redacted]</code> in logs and reports, so a
        common word used as a value is masked everywhere too. A missing or unreadable file fails the checks.
        Validate does not use this file yet, so a green Validate says nothing about logged-in coverage.
      </div>
      <div className="project-block__add">
        <button type="submit" className="composer__submit" style={{ background: 'var(--primary)' }} disabled={busy}>
          {busy ? 'Saving…' : 'Save env file path'}
        </button>
      </div>
      {saved && <div className="gh-success">Test credentials env file saved.</div>}
      {error && <div className="gh-error">{error}</div>}
    </form>
  )
}
