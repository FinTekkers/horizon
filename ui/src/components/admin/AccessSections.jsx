import { useEffect, useState } from 'react'
import { saveToken, regenerateGatePin, listApiTokens, createApiToken, revokeApiToken } from '../../api'
import { GithubIcon, LockIcon } from '../icons'

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
      <h2 className="panel__title admin__panel-title">
        <LockIcon size={18} />
        Security · your gate PIN
      </h2>
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
      <h2 className="panel__title admin__panel-title">
        <LockIcon size={18} />
        Personal API tokens
      </h2>
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
      <h2 className="panel__title admin__panel-title">
        <GithubIcon size={18} />
        GitHub access
      </h2>
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

// HZ-564: Access › GitHub access.
export function GitHubSection({ sync }) {
  return <TokenPanel sync={sync} />
}

// HZ-564: Access › Your PIN and API tokens.
export function AccountSection() {
  return (
    <>
      <SecurityPanel />
      <ApiTokensPanel />
    </>
  )
}
