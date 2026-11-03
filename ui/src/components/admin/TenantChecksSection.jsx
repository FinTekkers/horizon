import { Fragment, useEffect, useState } from 'react'
import { getTenantChecks, saveTenantChecks } from '../../api'
import { TARGETABLE_SLOTS, TargetedBox, targetedToSend } from './RepoSettings'

const SLOTS = [
  { key: 'install', label: 'Install', placeholder: 'npm ci' },
  { key: 'test', label: 'Test', placeholder: 'npm test' },
  { key: 'e2e', label: 'End-to-end tests', placeholder: 'npm run test:e2e' },
]

const EMPTY = { install: '', test: '', e2e: '' }

// HZ-703: a member's own project's check commands — install, test and e2e
// for its one repository, over HZ-697's tenant checks API. The owner sets
// these, and lint and screenshots, in Projects instead. An empty box clears
// that command; saving needs the gate PIN, like Admin's own saves.
export default function TenantChecksSection({ project }) {
  const repo = project?.repos?.[0]?.repo ?? null
  const projectId = project?.id ?? null
  const [values, setValues] = useState(EMPTY)
  // HZ-750: the slots opted into a fix round's targeted run.
  const [targeted, setTargeted] = useState([])
  const [load, setLoad] = useState({ loading: true, error: null })
  const [save, setSave] = useState({ busy: false, error: null, saved: false })

  useEffect(() => {
    if (!repo) return undefined
    let live = true
    setLoad({ loading: true, error: null })
    getTenantChecks(projectId, repo)
      .then((data) => {
        if (!live) return
        const checks = data.checks || {}
        setValues(Object.fromEntries(SLOTS.map(({ key }) => [key, checks[key] ?? ''])))
        setTargeted(data.targeted ?? [])
        setLoad({ loading: false, error: null })
      })
      .catch((err) => live && setLoad({ loading: false, error: err.message }))
    return () => {
      live = false
    }
  }, [projectId, repo])

  const submit = async (e) => {
    e.preventDefault()
    if (save.busy) return
    setSave({ busy: true, error: null, saved: false })
    try {
      const result = await saveTenantChecks(projectId, repo, { ...values, targeted: targetedToSend(targeted, values) })
      setTargeted(result?.targeted ?? [])
      setSave({ busy: false, error: null, saved: true })
    } catch (err) {
      const error = err.message === 'pin_needed' ? 'Your gate PIN is needed to save. Find it in Your PIN and API tokens.' : err.message
      setSave({ busy: false, error, saved: false })
    }
  }

  return (
    <div className="panel admin__panel">
      <h2 className="panel__title admin__panel-title">Your project's check commands</h2>
      <div className="panel__subtitle">
        The commands Horizon runs to install, test and end-to-end test your repository before it opens a pull request.
        Each runs as <code>sh -c</code>, one command per line. An empty box is skipped. Do not put tokens or secrets in
        commands.
      </div>

      {!repo && <div className="gh-note">Connect a repository first, from your project's board.</div>}
      {repo && load.loading && <div className="gh-note">Loading the check commands for {repo}…</div>}
      {repo && load.error && (
        <div className="gh-error" role="alert">
          {load.error}
        </div>
      )}

      {repo && !load.loading && !load.error && (
        <form className="repo-checks__form" onSubmit={submit}>
          <div className="gh-note">
            For <strong>{repo}</strong>.
          </div>
          {SLOTS.map(({ key, label, placeholder }) => (
            <Fragment key={key}>
              <label className="field">
                <span className="field__label">{label}</span>
                <textarea
                  className="field__input"
                  placeholder={placeholder}
                  rows={Math.max(1, values[key].split('\n').length)}
                  maxLength={2000}
                  value={values[key]}
                  onChange={(e) => {
                    setSave((s) => ({ ...s, saved: false }))
                    setValues({ ...values, [key]: e.target.value })
                  }}
                />
              </label>
              {TARGETABLE_SLOTS.includes(key) && (
                <TargetedBox
                  slotLabel={label}
                  repo={repo}
                  command={values[key]}
                  checked={targeted.includes(key)}
                  onChange={(on) => {
                    setSave((s) => ({ ...s, saved: false }))
                    setTargeted(on ? [...targeted, key] : targeted.filter((slot) => slot !== key))
                  }}
                />
              )}
            </Fragment>
          ))}
          {save.error && (
            <div className="gh-error" role="alert">
              {save.error}
            </div>
          )}
          {save.saved && (
            <div className="gh-success" role="status">
              Saved. The next run uses these commands.
            </div>
          )}
          <div className="composer__actions">
            <button className="composer__submit" type="submit" disabled={save.busy}>
              {save.busy ? 'Saving…' : 'Save check commands'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
