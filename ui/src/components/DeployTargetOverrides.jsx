import { Fragment, useEffect, useState } from 'react'
import { getDeployTargetConfig, createDeployTarget, updateDeployTarget, deleteDeployTarget } from '../api'

// HZ-259: one row per repo connected to an enabled project, joined to its
// deploy_target row or shown as "none". Create, edit and delete each ask for
// the gate PIN first; it lives in this component's state only, goes only in
// the x-human-key header, and is cleared after every request. The server runs
// checkRunnable on every write, so a service horizon-deploy.sudoers does not
// permit is refused — the sudoers file stays the boundary.

const FIELDS = [
  { name: 'key', label: 'Key' },
  { name: 'script', label: 'Script' },
  { name: 'service', label: 'Service' },
  { name: 'extraServices', label: 'Extra services (comma-separated)' },
  { name: 'repoDir', label: 'Repo dir' },
  { name: 'stateKey', label: 'State key' },
  { name: 'healthUrl', label: 'Health URL' },
  { name: 'healthCheckType', label: 'Health check type' },
]

const OVERRIDE_ERROR = {
  400: 'Not saved — a field is missing or badly formatted.',
  401: 'Gate PIN incorrect.',
  404: 'That target no longer exists.',
  409: 'Another target already uses that key or repo.',
}

function overrideError(err) {
  if (err.code === 'deploy_target_invalid' && err.reason) return `Not saved — ${err.reason}.`
  return Object.hasOwn(OVERRIDE_ERROR, err.status ?? '') ? OVERRIDE_ERROR[err.status] : 'Request failed — try again.'
}

const slugOf = (repo) => repo.split('/').pop().toLowerCase().replace(/[^a-z0-9-]/g, '-')

function formValues(repo, target) {
  if (!target) return { ...Object.fromEntries(FIELDS.map((f) => [f.name, ''])), key: slugOf(repo), stateKey: slugOf(repo) }
  return { ...target, extraServices: (target.extraServices ?? []).join(', ') }
}

function bodyOf(repo, values) {
  const { key: _key, extraServices, ...fields } = values
  const extras = extraServices.split(',').map((s) => s.trim()).filter(Boolean)
  const body = { repo }
  for (const { name } of FIELDS) if (name !== 'key' && name !== 'extraServices') body[name] = fields[name].trim()
  if (extras.length) body.extraServices = extras
  return body
}

function connectedRepos(projects) {
  const repos = projects.filter((p) => p.enabled).flatMap((p) => (p.repos || []).map((r) => r.repo))
  return [...new Set(repos)]
}

function OverrideRow({ repo, target, onChanged }) {
  // mode: null | 'edit' | 'delete'; prompting: the PIN prompt is open.
  const [mode, setMode] = useState(null)
  const [values, setValues] = useState(null)
  const [prompting, setPrompting] = useState(false)
  const [pin, setPin] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const close = () => {
    setMode(null)
    setPrompting(false)
    setPin('')
    setError(null)
  }
  const openEdit = () => {
    setValues(formValues(repo, target))
    setError(null)
    setMode('edit')
  }
  const openDelete = () => {
    setError(null)
    setMode('delete')
    setPrompting(true)
  }
  const cancelPrompt = () => {
    setPin('')
    setPrompting(false)
    if (mode === 'delete') setMode(null)
  }

  const confirm = async () => {
    if (!pin || busy) return
    setBusy(true)
    setError(null)
    try {
      if (mode === 'delete') await deleteDeployTarget(target.key, pin)
      else if (target) await updateDeployTarget(target.key, bodyOf(repo, values), pin)
      else await createDeployTarget({ key: values.key.trim(), ...bodyOf(repo, values) }, pin)
      close()
      onChanged()
    } catch (err) {
      setError(overrideError(err))
    } finally {
      setPin('')
      setBusy(false)
    }
  }

  const action = mode === 'delete' ? 'delete' : 'save'
  return (
    <div role="group" aria-label={`Deploy target for ${repo}`}>
      <div className="deploy-target-row">
        <span className="deploy-target-row__repo">{repo}</span>
        {target ? (
          <>
            <span className="deploy-target-row__tag">{target.key}</span>
            <span className="deploy-target-row__tag">{target.script}</span>
            <span className="deploy-target-row__service">{target.service}</span>
          </>
        ) : (
          <span className="deploy-target-row__tag">none</span>
        )}
      </div>
      {!mode && (
        <div className="repo-checks">
          <button type="button" className="repo-checks__toggle" onClick={openEdit}>
            {target ? 'Edit' : 'Add target'}
          </button>
          {target && (
            <button type="button" className="repo-checks__toggle" onClick={openDelete}>
              Delete
            </button>
          )}
        </div>
      )}
      {mode === 'edit' && (
        <form
          className="repo-checks__form"
          onSubmit={(e) => {
            e.preventDefault()
            setError(null)
            setPrompting(true)
          }}
        >
          {FIELDS.map(({ name, label }) => (
            <Fragment key={name}>
              <label className="field">
                <span className="field__label">{label}</span>
                <input
                  className="field__input"
                  maxLength={300}
                  readOnly={name === 'key' && !!target}
                  value={values[name]}
                  onChange={(e) => setValues({ ...values, [name]: e.target.value })}
                />
              </label>
              {name === 'healthCheckType' && (
                <div className="gh-note">
                  Informational only — it does not change how real deploys run. The target's script decides how
                  health is checked.
                </div>
              )}
            </Fragment>
          ))}
          {!prompting && (
            <div className="project-block__add">
              <button type="submit" className="composer__submit" style={{ background: 'var(--primary)' }}>
                Save
              </button>
              <button type="button" className="repo-checks__toggle" onClick={close}>
                Cancel
              </button>
            </div>
          )}
        </form>
      )}
      {mode === 'delete' && (
        <div className="gh-note" role="alert">
          Releases of {repo} will no longer deploy. A deleted target does not come back on restart, even a seeded one.
        </div>
      )}
      {prompting && (
        <div className="project-block__add">
          <input
            className="field__input"
            type="password"
            autoComplete="off"
            aria-label={`Gate PIN to ${action} deploy target for ${repo}`}
            placeholder={`Gate PIN to ${action}`}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && confirm()}
          />
          <button type="button" className="composer__submit" style={{ background: 'var(--primary)' }} onClick={confirm} disabled={!pin || busy}>
            {busy ? 'Working…' : mode === 'delete' ? 'Delete target' : 'Confirm save'}
          </button>
          <button type="button" className="repo-checks__toggle" onClick={cancelPrompt} disabled={busy}>
            Cancel
          </button>
        </div>
      )}
      {error && <div className="gh-error">{error}</div>}
    </div>
  )
}

export default function DeployTargetOverrides({ projects, onChanged }) {
  const [targets, setTargets] = useState(null)
  const [loadError, setLoadError] = useState(null)

  const load = () =>
    Promise.resolve()
      .then(() => getDeployTargetConfig())
      .then((result) => {
        setTargets(result.targets || [])
        setLoadError(null)
      })
      .catch(() => setLoadError('Could not load deploy targets.'))

  useEffect(() => {
    load()
  }, [])

  const repos = connectedRepos(projects)
  const byRepo = new Map((targets || []).map((t) => [t.repo, t]))
  const changed = () => {
    load()
    onChanged?.()
  }

  return (
    <div className="panel admin__panel">
      <div className="panel__title">Deploy target overrides</div>
      <div className="panel__subtitle">
        Every repo connected to an enabled project, with its deploy target or none. Each save or delete asks for the
        gate PIN. A target may only name services horizon-deploy.sudoers already permits.
      </div>

      {loadError && <div className="gh-error">{loadError}</div>}
      {targets && repos.length === 0 && <div className="gh-note">No repos connected to an enabled project.</div>}
      {targets &&
        repos.map((repo) => (
          <OverrideRow key={`${repo}:${byRepo.get(repo)?.key ?? ''}`} repo={repo} target={byRepo.get(repo) ?? null} onChanged={changed} />
        ))}
    </div>
  )
}
