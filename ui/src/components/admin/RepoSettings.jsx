import { useState } from 'react'
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

// HZ-304: a repo's 'no checks' or 'no deploy' mark. Every flip asks for the
// gate PIN, exactly like ProjectEnabledToggle: the PIN lives in this form's
// state only until the request settles and goes out in a header
// (saveRepoMarks). The switch shows the server's value from the snapshot, so
// a refused PIN leaves it as it was.
function RepoMarkToggle({ projectId, repo, mark, label, on }) {
  const [asking, setAsking] = useState(false)
  const [pin, setPin] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const verb = on ? 'Clear' : 'Set'

  const cancel = () => {
    setAsking(false)
    setPin('')
    setError(null)
  }

  const submit = async (e) => {
    e.preventDefault()
    if (!pin || busy) return
    setBusy(true)
    setError(null)
    try {
      await saveRepoMarks(projectId, repo, { [mark]: !on }, pin)
      setAsking(false)
    } catch (err) {
      setError(err.status === 401 ? 'Gate PIN incorrect' : err.message)
    } finally {
      setPin('')
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
          <input
            className="field__input"
            type="password"
            autoComplete="off"
            aria-label={`Gate PIN to change ${label.toLowerCase()} for ${repo}`}
            placeholder={`Gate PIN to ${verb.toLowerCase()} '${label.toLowerCase()}'`}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoFocus
          />
          <button type="submit" className="composer__submit" style={{ background: 'var(--primary)' }} disabled={!pin || busy}>
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
// pre-merge. Saving asks for the gate PIN every time (saveRepoChecks sends it
// in a header only): these commands judge every agent's work. The detected
// defaults load only when the block is opened, so a down farm never slows
// the page.
export function RepoChecks({ projectId, repoConn }) {
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState(() => savedChecks(repoConn))
  const [defaults, setDefaults] = useState(null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  const toggle = () => {
    if (!open && defaults === null) {
      getRepoCheckDefaults(projectId, repoConn.repo)
        .then((result) => setDefaults(result.defaults || {}))
        .catch(() => setDefaults({}))
    }
    if (!open) setValues(savedChecks(repoConn))
    setOpen(!open)
  }

  const submit = async (e) => {
    e.preventDefault()
    if (!pin || busy) return
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const result = await saveRepoChecks(projectId, repoConn.repo, values, pin)
      setValues(Object.fromEntries(CHECK_SLOTS.map(({ key }) => [key, result.checks?.[key] ?? ''])))
      setSaved(true)
    } catch (err) {
      setError(err.status === 401 ? 'Gate PIN incorrect' : err.message)
    } finally {
      setPin('')
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
            <label className="field" key={key}>
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
          ))}
          <div className="project-block__add">
            <input
              className="field__input"
              type="password"
              autoComplete="off"
              aria-label={`Gate PIN to save check commands for ${repoConn.repo}`}
              placeholder="Gate PIN to save"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
            <button type="submit" className="composer__submit" style={{ background: 'var(--primary)' }} disabled={!pin || busy}>
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
// into this repo's test/e2e checks and deploy smoke check. Saving asks for
// the gate PIN every time, like the commands above. Horizon stores the path
// only; the farm reads the file at run time, so no value reaches this page.
function RepoTestEnvFile({ projectId, repoConn }) {
  const [value, setValue] = useState(repoConn.testEnvFile ?? '')
  const [pin, setPin] = useState('')
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (!pin || busy) return
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const result = await saveRepoTestEnvFile(projectId, repoConn.repo, value.trim(), pin)
      setValue(result.testEnvFile ?? '')
      setSaved(true)
    } catch (err) {
      setError(err.status === 401 ? 'Gate PIN incorrect' : err.message)
    } finally {
      setPin('')
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
        <input
          className="field__input"
          type="password"
          autoComplete="off"
          aria-label={`Gate PIN to save the test credentials env file for ${repoConn.repo}`}
          placeholder="Gate PIN to save"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
        />
        <button type="submit" className="composer__submit" style={{ background: 'var(--primary)' }} disabled={!pin || busy}>
          {busy ? 'Saving…' : 'Save env file path'}
        </button>
      </div>
      {saved && <div className="gh-success">Test credentials env file saved.</div>}
      {error && <div className="gh-error">{error}</div>}
    </form>
  )
}
