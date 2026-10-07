import { Fragment, useEffect, useState } from 'react'
import {
  saveToken,
  createProject,
  addRepoToProject,
  disconnectRepo,
  regenerateGatePin,
  getDeployTargets,
  getCheckFlakes,
  dryRunDeployTarget,
  listApiTokens,
  createApiToken,
  revokeApiToken,
  setProjectEnabled,
  setProjectAutopilot,
  saveRepoChecks,
  saveRepoMarks,
  getRepoCheckDefaults,
  getRepoWebhooks,
  fixRepoWebhook,
} from '../api'
import { BackIcon, GithubIcon, LockIcon } from './icons'
import DeployTargetOverrides from './DeployTargetOverrides'
import { WEBHOOK_IMPACT, repoHasDeployTarget, webhookImpact } from '../domain/webhookImpact'

function SecurityPanel() {
  const [pin, setPin] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await regenerateGatePin()
      setPin(result.pin)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel admin__panel">
      <div className="panel__title admin__panel-title">
        <LockIcon size={18} />
        Security · your gate PIN
      </div>
      <div className="panel__subtitle">
        A gate PIN is a cryptographic blocker, separate from your login, so an AI agent can never approve its own
        work — every account gets its own, generated automatically. Gate actions (approve, send back, restart
        phase) require it; the server stores only a hash.
      </div>

      {pin && (
        <div className="admin-status">
          <span className="admin-status__dot" style={{ background: 'var(--success)' }} />
          Your new PIN: <strong style={{ fontFamily: 'var(--font-mono)', marginLeft: 4 }}>{pin}</strong> — shown
          once, saved in this browser.
        </div>
      )}

      {error && <div className="gh-error">{error}</div>}

      <div className="composer__actions">
        <button className="composer__submit" style={{ background: 'var(--success)' }} onClick={submit} disabled={busy}>
          {busy ? 'Generating…' : 'Regenerate my PIN'}
        </button>
      </div>
    </div>
  )
}

// Mirrors the server's API_TOKEN_DEFAULT_DAYS / API_TOKEN_MAX_DAYS (auth.js),
// which re-validates — these only shape the input.
const API_TOKEN_DEFAULT_DAYS = 90
const API_TOKEN_MAX_DAYS = 365

const formatWhen = (iso) => (iso ? new Date(iso).toLocaleDateString() : 'never')

function ApiTokenRow({ token, onRevoke }) {
  const [busy, setBusy] = useState(false)

  const revoke = async () => {
    if (!window.confirm(`Revoke the token "${token.name}"? Anything using it stops working immediately.`)) return
    setBusy(true)
    try {
      await onRevoke(token.id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="api-token-row">
      <span className="api-token-row__name">{token.name}</span>
      <span className="api-token-row__last4">…{token.last4}</span>
      <span className="api-token-row__dates">
        created {formatWhen(token.createdAt)} · last used {formatWhen(token.lastUsedAt)} · expires{' '}
        {formatWhen(token.expiresAt)}
      </span>
      <button className="api-token-row__revoke" onClick={revoke} disabled={busy}>
        Revoke
      </button>
    </div>
  )
}

// Personal API tokens (HZ-179). The raw token lives only in this component's
// state, from the create response until it is dismissed or the page is left —
// never in localStorage, and the server cannot show it again.
function ApiTokensPanel() {
  const [tokens, setTokens] = useState(null)
  const [name, setName] = useState('')
  const [days, setDays] = useState(String(API_TOKEN_DEFAULT_DAYS))
  const [created, setCreated] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const refresh = () =>
    listApiTokens()
      .then((result) => setTokens(result.tokens || []))
      .catch((err) => setError(err.message))

  useEffect(() => {
    refresh()
  }, [])

  const submit = async () => {
    const expiresInDays = Number(days)
    if (!name.trim()) {
      setError('Give the token a name')
      return
    }
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > API_TOKEN_MAX_DAYS) {
      setError(`Expiry must be a whole number of days from 1 to ${API_TOKEN_MAX_DAYS}`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await createApiToken({ name: name.trim(), expiresInDays })
      setCreated({ name: result.name, token: result.token })
      setName('')
      setDays(String(API_TOKEN_DEFAULT_DAYS))
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id) => {
    setError(null)
    try {
      await revokeApiToken(id)
      await refresh()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="panel admin__panel api-tokens">
      <div className="panel__title admin__panel-title">
        <LockIcon size={18} />
        Personal API tokens
      </div>
      <div className="panel__subtitle">
        For scripts: send <code>Authorization: Bearer &lt;token&gt;</code> to call the API as you. A token can never
        approve a gate or manage tokens — those still need this browser and your gate PIN.
      </div>

      {created && (
        <div className="api-tokens__created">
          <div>
            New token <strong>{created.name}</strong> — copy it now, it will not be shown again:
          </div>
          <code className="api-tokens__raw">{created.token}</code>
          <div className="composer__actions">
            <button className="composer__cancel" onClick={() => navigator.clipboard?.writeText(created.token)}>
              Copy
            </button>
            <button className="composer__cancel" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      {tokens && tokens.length === 0 && <div className="gh-note">No active tokens.</div>}
      {tokens && tokens.map((token) => <ApiTokenRow key={token.id} token={token} onRevoke={revoke} />)}

      <div className="api-tokens__form">
        <input
          className="field__input"
          placeholder="Token name, e.g. ci-bot"
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <span className="api-tokens__expiry">
          <label className="api-tokens__expiry-label" htmlFor="api-token-days">
            Expires in
          </label>
          <span className="api-tokens__days-field">
            <input
              id="api-token-days"
              className="api-tokens__days"
              type="number"
              min={1}
              max={API_TOKEN_MAX_DAYS}
              aria-label="Expires in days"
              aria-describedby="api-token-days-hint"
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
            <span className="api-tokens__unit" aria-hidden="true">
              days
            </span>
          </span>
        </span>
        <button className="composer__submit" style={{ background: 'var(--primary)' }} onClick={submit} disabled={busy}>
          {busy ? 'Creating…' : 'Create token'}
        </button>
      </div>
      <div id="api-token-days-hint" className="api-tokens__hint">
        1 to {API_TOKEN_MAX_DAYS} days
      </div>
      {error && <div className="gh-error">{error}</div>}
    </div>
  )
}

function TokenPanel({ sync }) {
  const [token, setToken] = useState('')
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (token.trim().length < 10) {
      setError('Paste a GitHub personal access token')
      return
    }
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      const result = await saveToken(token.trim())
      setToken('')
      setSuccess(`Token saved — authenticated as ${result.login}.`)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel admin__panel">
      <div className="panel__title admin__panel-title">
        <GithubIcon size={18} />
        GitHub access
      </div>
      <div className="panel__subtitle">
        One token shared by all connected repositories — it must have access to each repo you connect below.
      </div>

      <div className="admin-status">
        <span className="admin-status__dot" style={{ background: sync?.tokenConfigured ? 'var(--success)' : 'var(--neutral-badge)' }} />
        {sync?.tokenConfigured ? 'Token configured' : 'No token yet'}
      </div>

      <div className="field">
        <div className="field__label field__label--row">
          Access token
          <a
            className="field__hint-link"
            href="https://github.com/settings/personal-access-tokens/new"
            target="_blank"
            rel="noopener noreferrer"
          >
            Create one on GitHub ↗
          </a>
        </div>
        <input
          className="field__input"
          type="password"
          placeholder={sync?.tokenConfigured ? 'Paste a new token to replace the saved one' : 'github_pat_… or ghp_…'}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>

      <details className="howto">
        <summary className="howto__summary">How to create a token</summary>
        <ol className="howto__steps">
          <li>
            Open{' '}
            <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">
              github.com/settings/personal-access-tokens/new
            </a>{' '}
            (fine-grained personal access token).
          </li>
          <li>
            Set <strong>Resource owner</strong> (dropdown at the top of the form) to the account or org that owns
            the repos (e.g. <code>FinTekkers</code>) — its repos only appear after this is selected. Org tokens
            may need an admin's approval.
          </li>
          <li>
            Under <strong>Repository access</strong> choose <em>Only select repositories</em> and pick every repo
            you plan to connect (or all repos in the org).
          </li>
          <li>
            Under <strong>Permissions → Repository permissions</strong> grant: <strong>Issues</strong>,{' '}
            <strong>Actions</strong>, <strong>Contents</strong>, <strong>Pull requests</strong> —{' '}
            <em>Read and write</em>; <strong>Checks</strong> and <strong>Commit statuses</strong> —{' '}
            <em>Read-only</em> (Metadata is added automatically).
          </li>
          <li>
            If the org isn't listed as a resource owner, an org owner must allow fine-grained tokens first (org{' '}
            <strong>Settings → Third-party Access → Personal access tokens</strong>) — or use a{' '}
            <a
              href="https://github.com/settings/tokens/new?scopes=repo,workflow"
              target="_blank"
              rel="noopener noreferrer"
            >
              classic token
            </a>{' '}
            with the <code>repo</code> and <code>workflow</code> scopes.
          </li>
          <li>Generate the token, copy it, and paste it above — it's shown by GitHub only once.</li>
        </ol>
      </details>

      {error && <div className="gh-error">{error}</div>}
      {success && <div className="gh-success">{success}</div>}
      <div className="gh-note">
        The token is validated against GitHub, then stored only in the local server database (gitignored) and
        never sent back to the browser.
      </div>

      <div className="composer__actions">
        <button className="composer__submit" style={{ background: 'var(--primary)' }} onClick={submit} disabled={busy}>
          {busy ? 'Validating…' : 'Save token'}
        </button>
      </div>
    </div>
  )
}

const RESULT_COLOR = { ok: 'var(--success)', failed: 'var(--danger)', never: 'var(--neutral-badge)' }

const DRY_RUN_ERROR = { 401: 'Gate PIN incorrect', 409: 'Dry run already running' }

// HZ-258: five read-only checks of the stored target (script, repo dir,
// service, sudo, health). Asks for the gate PIN on every run and sends it in
// a header only; the request carries nothing else, so it cannot change what is
// probed. Results live in this component only.
function DeployDryRun({ target }) {
  const [pin, setPin] = useState('')
  const [results, setResults] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    if (!pin || busy) return
    setBusy(true)
    setError(null)
    setResults(null)
    try {
      const result = await dryRunDeployTarget(target.key, pin)
      setResults(result.results || [])
    } catch (err) {
      setError(Object.hasOwn(DRY_RUN_ERROR, err.status ?? '') ? DRY_RUN_ERROR[err.status] : err.message)
    } finally {
      setPin('')
      setBusy(false)
    }
  }

  return (
    <div className="deploy-dry-run">
      <div className="project-block__add">
        <input
          className="field__input"
          type="password"
          autoComplete="off"
          aria-label={`Gate PIN to dry-run ${target.repo}`}
          placeholder="Gate PIN to dry-run"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
        />
        <button type="button" className="composer__submit" style={{ background: 'var(--primary)' }} onClick={run} disabled={!pin || busy}>
          {busy ? 'Running…' : 'Run'}
        </button>
      </div>
      {error && <div className="gh-error">{error}</div>}
      {results && (
        <ol className="deploy-dry-run__list" aria-label={`Dry run results for ${target.repo}`}>
          {results.map((r) => (
            <li key={r.check} className={`deploy-dry-run__item deploy-dry-run__item--${r.pass ? 'pass' : 'fail'}`}>
              <span className="deploy-dry-run__check">{r.check}</span>
              <span className="deploy-dry-run__badge">{r.pass ? 'pass' : 'fail'}</span>
              <span className="deploy-dry-run__reason">{r.reason}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function DeployTargetRow({ target }) {
  const [open, setOpen] = useState(false)
  const lastAt = target.lastAt ? new Date(target.lastAt).toLocaleString() : 'never deployed'
  return (
    <div>
      <div className="deploy-target-row">
        <span className="admin-status__dot" style={{ background: RESULT_COLOR[target.lastResult] || RESULT_COLOR.never }} />
        <span className="deploy-target-row__repo">{target.repo}</span>
        <span className="deploy-target-row__service">{target.service}</span>
        <span className="deploy-target-row__tag">{target.lastTag || 'no deploy yet'}</span>
        <span className="deploy-target-row__result">{target.lastResult} · {lastAt}</span>
      </div>
      <div className="repo-checks">
        <button type="button" className="repo-checks__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} Dry run
        </button>
      </div>
      {open && <DeployDryRun target={target} />}
    </div>
  )
}

// Status and Dry run only: this panel renders the deploy_target table's rows
// plus each target's on-disk deploy state, with no create, edit, or delete
// path here. Its one action, Dry run (HZ-258), only reads. Targets are edited
// in Deploy target overrides (HZ-259), PIN-gated and re-validated against
// horizon-deploy.sudoers. AdminPage owns the fetch (HZ-303: the project
// rows read the same targets) and re-reads after each edit, so this list (and
// its Dry run) picks up new targets without a reload.
function DeployTargetsPanel({ targets, error }) {
  return (
    <div className="panel admin__panel">
      <div className="panel__title">Deploy targets</div>
      <div className="panel__subtitle">
        Status and Dry run — stored in the deploy_target table. Edit targets in Deploy target overrides below.
        Dry run checks a target without deploying, restarting or writing anything.
      </div>

      {error && <div className="gh-error">{error}</div>}
      {targets && targets.length === 0 && <div className="gh-note">No deploy targets registered.</div>}
      {targets && targets.map((target) => <DeployTargetRow key={target.key} target={target} />)}
    </div>
  )
}

// HZ-327: "2026-10-07T09:12:00.000Z" -> "2026-10-07 09:12 UTC" — the same in
// every browser locale.
const utcMinute = (iso) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '—')

const PING_LABELS = { sent: 'sent', failed: 'send failed', skipped: 'not sent (notifications off)', pending: 'sending' }

// HZ-327: the farm reruns a failing check once; a pass on rerun is a flake,
// recorded here instead of costing an attempt. Read-only: nothing is skipped
// or quarantined, so this list is where repeat offenders show up to be fixed.
// AdminPage owns the fetch, like the deploy targets above.
function FlakyTestsPanel({ data, error }) {
  return (
    <div className="panel admin__panel">
      <div className="panel__title">Flaky tests</div>
      <div className="panel__subtitle">
        Tests that failed and then passed on the same code — on the farm&apos;s one rerun, or across runs. The owner
        is pinged once when a test flakes 3 times in 7 days.
      </div>

      {error && <div className="gh-error">{error}</div>}
      {data && data.repos.length === 0 && <div className="gh-note">No flaky tests recorded.</div>}
      {data &&
        data.repos.map(({ repo, tests }) => (
          <div key={repo} style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{repo}</div>
            <table
              aria-label={`Flaky tests in ${repo}`}
              style={{ borderCollapse: 'collapse', font: '500 13px var(--font-sans)', width: '100%' }}
            >
              <thead>
                <tr>
                  <th align="left">Test</th>
                  <th align="left">Flakes (7 d / total)</th>
                  <th align="left">Last seen</th>
                  <th align="left">Last item</th>
                  <th align="left">Pinged</th>
                </tr>
              </thead>
              <tbody>
                {tests.map((t) => (
                  <tr key={t.test}>
                    <td style={{ wordBreak: 'break-word' }}>
                      {t.test}
                      {!t.name_parsed && <span className="gh-note"> (test name not parsed)</span>}
                    </td>
                    <td>{`${t.count_7d} / ${t.count}`}</td>
                    <td>{utcMinute(t.last_seen)}</td>
                    <td>{t.last_item_id || '—'}</td>
                    <td>{t.ping_status ? `${PING_LABELS[t.ping_status] || t.ping_status} ${utcMinute(t.pinged_at)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  )
}

const CHECK_SLOTS = [
  { key: 'install', label: 'Install' },
  { key: 'test', label: 'Test' },
  { key: 'lint', label: 'Lint' },
  { key: 'e2e', label: 'E2E' },
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
function RepoMarks({ projectId, repoConn }) {
  const configured = CHECK_SLOTS.some(({ key }) => repoConn.checks?.[key])
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
function RepoChecks({ projectId, repoConn }) {
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
    </div>
  )
}

// HZ-244: why a webhook row is not plain ok/missing, in a few words.
const WEBHOOK_REASON = {
  foreign_url: 'other host',
  secret_not_configured: 'secret not configured',
  webhook_url_not_public: 'webhook URL not public',
  github_unreachable: 'GitHub unreachable',
}

function WebhookStatus({ webhook }) {
  const detail = webhook.httpStatus
    ? `GitHub ${webhook.httpStatus}`
    : Object.hasOwn(WEBHOOK_REASON, webhook.reason ?? '')
      ? WEBHOOK_REASON[webhook.reason]
      : null
  return (
    <>
      <span className={`repo-webhook repo-webhook--${webhook.status}`}>
        Webhook: {webhook.status}
        {detail ? ` (${detail})` : ''}
      </span>
      <span className="repo-webhook__code">
        {webhook.lastResponseCode != null ? `last delivery ${webhook.lastResponseCode}` : 'no deliveries'}
      </span>
    </>
  )
}

// HZ-303: under a missing or mismatched webhook row, what that breaks for this
// repo. The copy lives in domain/webhookImpact.js.
function WebhookImpact({ status, hasDeployTarget }) {
  const lines = webhookImpact({ status, hasDeployTarget })
  if (!lines) return null
  return (
    <div className="gh-note repo-webhook__impact">
      {lines.map((line) => (
        <div key={line}>{line}</div>
      ))}
    </div>
  )
}

// HZ-244: Fix webhook — creates a missing hook or repairs Horizon's own
// mismatched one. Same PIN handling as ProjectEnabledToggle: the PIN lives in
// this form's state only until the request settles and goes out in a header.
function FixWebhookForm({ projectId, repo, onFixed }) {
  const [asking, setAsking] = useState(false)
  const [pin, setPin] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

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
      await fixRepoWebhook(projectId, repo, pin)
      setAsking(false)
      onFixed?.()
    } catch (err) {
      setError(err.status === 401 ? 'Gate PIN incorrect' : err.message)
    } finally {
      setPin('')
      setBusy(false)
    }
  }

  if (!asking) {
    return (
      <div className="project-block__add" style={{ marginTop: 0 }}>
        <button type="button" className="composer__cancel" onClick={() => setAsking(true)}>
          Fix webhook
        </button>
        {error && <div className="gh-error">{error}</div>}
        <div className="gh-note repo-webhook__hint">{WEBHOOK_IMPACT.FIX_HINT}</div>
      </div>
    )
  }
  return (
    <>
      <div className="gh-note repo-webhook__hint">{WEBHOOK_IMPACT.FIX_HINT}</div>
      <form className="project-block__add" style={{ marginTop: 0 }} onSubmit={submit}>
        <input
          className="field__input"
          type="password"
          autoComplete="off"
          aria-label={`Gate PIN to fix the ${repo} webhook`}
          placeholder="Gate PIN to fix this webhook"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          autoFocus
        />
        <button type="submit" className="composer__submit" style={{ background: 'var(--primary)' }} disabled={!pin || busy}>
          {busy ? 'Fixing…' : 'Fix'}
        </button>
        <button type="button" className="composer__cancel" onClick={cancel}>
          Cancel
        </button>
      </form>
      {error && <div className="gh-error">{error}</div>}
    </>
  )
}

function RepoRow({ projectId, repoConn, syncRepos, webhook }) {
  const [busy, setBusy] = useState(false)
  const state = syncRepos?.find((r) => r.repo === repoConn.repo)
  const failing = state?.last?.error
  const lastAt = state?.last?.at ? new Date(state.last.at).toLocaleTimeString() : null

  const disconnect = async () => {
    setBusy(true)
    try {
      await disconnectRepo(projectId, repoConn.repo)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="repo-row">
      <span
        className="admin-status__dot"
        style={{ background: failing ? 'var(--danger)' : state?.last ? 'var(--success)' : 'var(--neutral-badge)' }}
      />
      <a className="repo-row__name" href={`https://github.com/${repoConn.repo}`} target="_blank" rel="noopener noreferrer">
        {repoConn.repo}
      </a>
      <span className="repo-row__prefix">{repoConn.prefix}-*</span>
      {webhook && <WebhookStatus webhook={webhook} />}
      <span className="repo-row__status">
        {failing ? failing : lastAt ? `checked ${lastAt}` : 'waiting for first poll'}
      </span>
      <button
        className="repo-row__disconnect"
        title="Disconnect this repository (stops sync; existing items keep their history)"
        onClick={disconnect}
        disabled={busy}
      >
        ✕
      </button>
    </div>
  )
}

// HZ-208: a project's dispatch on/off switch. Every flip, both ways, asks for
// the gate PIN; it lives in this form's state only until the request settles,
// and goes out in a header (setProjectEnabled), never a URL or a log line.
// The switch shows the server's state from the snapshot — never an
// optimistic guess — so a refused PIN leaves it exactly as it was.
function ProjectEnabledToggle({ project }) {
  const [asking, setAsking] = useState(false)
  const [pin, setPin] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const next = !project.enabled
  const verb = next ? 'Enable' : 'Disable'

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
      await setProjectEnabled(project.id, next, pin)
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
          <input
            className="field__input"
            type="password"
            autoComplete="off"
            aria-label={`Gate PIN to ${verb.toLowerCase()} ${project.name}`}
            placeholder={`Gate PIN to ${verb.toLowerCase()} this project`}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoFocus
          />
          <button type="submit" className="composer__submit" style={{ background: 'var(--primary)' }} disabled={!pin || busy}>
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

// HZ-270: a project's Autopilot mode. Picking a mode asks for the gate PIN,
// exactly like ProjectEnabledToggle; the select always shows the server's
// value, so a refused PIN leaves it as it was. The last few changes show
// underneath, from the project_event audit trail.
const AUTOPILOT_MODES = ['off', 'shadow', 'on']

function ProjectAutopilot({ project }) {
  const [pending, setPending] = useState(null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const cancel = () => {
    setPending(null)
    setPin('')
    setError(null)
  }

  const submit = async (e) => {
    e.preventDefault()
    if (!pin || busy) return
    setBusy(true)
    setError(null)
    try {
      await setProjectAutopilot(project.id, pending, pin)
      setPending(null)
    } catch (err) {
      setError(err.status === 401 ? 'Gate PIN incorrect' : err.message)
    } finally {
      setPin('')
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
          <input
            className="field__input"
            type="password"
            autoComplete="off"
            aria-label={`Gate PIN to set ${project.name} Autopilot to ${pending}`}
            placeholder={`Gate PIN to set Autopilot to ${pending}`}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoFocus
          />
          <button type="submit" className="composer__submit" style={{ background: 'var(--primary)' }} disabled={!pin || busy}>
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

function ProjectPanel({ project, syncRepos, deployTargets }) {
  const [repo, setRepo] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [webhooks, setWebhooks] = useState({})
  const [webhooksError, setWebhooksError] = useState(null)
  const repoKey = project.repos.map((r) => r.repo).join(',')

  // HZ-244: live webhook status per repo — on mount, whenever the repo list
  // changes (a connect or disconnect), and after a Fix.
  const refreshWebhooks = () => {
    if (!repoKey) return setWebhooks({})
    return getRepoWebhooks(project.id)
      .then((result) => {
        setWebhooks(Object.fromEntries((result.webhooks || []).map((w) => [w.repo, w])))
        setWebhooksError(null)
      })
      .catch((err) => setWebhooksError(err.message))
  }

  useEffect(() => {
    refreshWebhooks()
  }, [project.id, repoKey])

  const submit = async () => {
    if (!repo.trim()) return
    setBusy(true)
    setError(null)
    try {
      await addRepoToProject(project.id, repo.trim())
      setRepo('')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="project-block">
      <div className="project-block__head">
        <div className="project-block__name">{project.name}</div>
        <ProjectEnabledToggle project={project} />
      </div>
      <ProjectAutopilot project={project} />
      {project.repos.map((r) => {
        const webhook = Object.hasOwn(webhooks, r.repo) ? webhooks[r.repo] : null
        return (
          <Fragment key={r.repo}>
            <RepoRow projectId={project.id} repoConn={r} syncRepos={syncRepos} webhook={webhook} />
            <WebhookImpact status={webhook?.status} hasDeployTarget={repoHasDeployTarget(deployTargets, r.repo)} />
            {(webhook?.status === 'missing' || webhook?.status === 'mismatched') && (
              <FixWebhookForm projectId={project.id} repo={r.repo} onFixed={refreshWebhooks} />
            )}
            <RepoMarks projectId={project.id} repoConn={r} />
            <RepoChecks projectId={project.id} repoConn={r} />
          </Fragment>
        )
      })}
      {webhooksError && <div className="gh-error">Webhook status unavailable: {webhooksError}</div>}
      {project.repos.length === 0 && <div className="gh-note" style={{ marginTop: 4 }}>No repositories connected yet.</div>}
      <div className="project-block__add">
        <input
          className="field__input"
          placeholder="Add a repo: owner/name or URL"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button className="composer__cancel" onClick={submit} disabled={busy}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
      {error && <div className="gh-error">{error}</div>}
    </div>
  )
}

function ProjectsPanel({ projects, sync, deployTargets }) {
  const [name, setName] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (name.trim().length < 2) return
    setBusy(true)
    setError(null)
    try {
      await createProject(name.trim())
      setName('')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel admin__panel">
      <div className="panel__title">Projects</div>
      <div className="panel__subtitle">
        A project is what the board tracks; it can span several repositories. Issues from every connected repo
        become work items (IDs use the repo's prefix, e.g. SH-12). The Execute step opens the PR in the item's own
        repo.
      </div>

      {projects.map((p) => (
        <ProjectPanel key={p.id} project={p} syncRepos={sync?.repos} deployTargets={deployTargets} />
      ))}
      {projects.length === 0 && <div className="gh-note">No projects yet — create one below.</div>}

      <div className="project-block__add" style={{ marginTop: 18 }}>
        <input
          className="field__input"
          placeholder="New project name, e.g. Shoreward"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button className="composer__submit" style={{ background: 'var(--primary)' }} onClick={submit} disabled={busy}>
          {busy ? 'Creating…' : 'Create project'}
        </button>
      </div>
      {error && <div className="gh-error">{error}</div>}
    </div>
  )
}

export default function AdminPage({ sync, projects, onBack }) {
  const [deployTargetsVersion, setDeployTargetsVersion] = useState(0)
  const [deployTargets, setDeployTargets] = useState({ targets: null, error: null })

  // One read of the deploy_target rows per version: the Deploy targets panel
  // lists them, and each project row uses them to say what a broken webhook
  // breaks (HZ-303). Bumped after each edit in Deploy target overrides.
  useEffect(() => {
    getDeployTargets()
      .then((result) => setDeployTargets({ targets: result.targets || [], error: null }))
      .catch((err) => setDeployTargets((prev) => ({ ...prev, error: err.message })))
  }, [deployTargetsVersion])

  const [checkFlakes, setCheckFlakes] = useState({ data: null, error: null })
  useEffect(() => {
    getCheckFlakes()
      .then((data) => setCheckFlakes({ data: { repos: data.repos || [] }, error: null }))
      .catch((err) => setCheckFlakes({ data: null, error: err.message }))
  }, [])

  return (
    <div className="admin">
      <button className="tracker__back" onClick={onBack}>
        <BackIcon />
        Back to board
      </button>
      <div className="admin__title">Admin</div>
      <SecurityPanel />
      <div style={{ height: 22 }} />
      <ApiTokensPanel />
      <div style={{ height: 22 }} />
      <TokenPanel sync={sync} />
      <div style={{ height: 22 }} />
      <DeployTargetsPanel targets={deployTargets.targets} error={deployTargets.error} />
      <div style={{ height: 22 }} />
      <FlakyTestsPanel data={checkFlakes.data} error={checkFlakes.error} />
      <div style={{ height: 22 }} />
      <DeployTargetOverrides projects={projects} onChanged={() => setDeployTargetsVersion((v) => v + 1)} />
      <div style={{ height: 22 }} />
      <ProjectsPanel projects={projects} sync={sync} deployTargets={deployTargets.targets} />
    </div>
  )
}
