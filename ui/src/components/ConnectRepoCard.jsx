import { useId, useState } from 'react'
import { TOKEN_PERMISSIONS, refusalText, tokenPageUrl } from './connectRepo'

// HZ-703: "Connect your repository", on a member's empty board until their
// project has a repository. `onConnect` is api.connectTenantRepo (HZ-697's
// tenant connect); its result goes up through `onConnected`, and App passes it
// back as `result` — App keeps it, so the connected view outlives the board
// frame that adds the repository, until `onDone`.
//
// The token lives only in its input's state and, for one request, in `sent`:
// the field is cleared before the request goes out, so it is empty after a
// success, a refusal and a failed request alike. A refusal is the server's
// own message, rendered as text.
export default function ConnectRepoCard({ project, result = null, onConnect, onConnected, settingsHref, onOpenSettings, onDone }) {
  const titleId = useId()
  const repoId = useId()
  const tokenId = useId()
  const [repo, setRepo] = useState('')
  const [token, setToken] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    const name = repo.trim()
    if (!name || !token) {
      setError({ text: 'Enter the repository as owner/name and paste your token.', hint: 'Nothing was saved.' })
      return
    }
    const sent = token
    setToken('')
    setBusy(true)
    setError(null)
    try {
      onConnected(await onConnect(project.id, name, sent))
    } catch (err) {
      setError(refusalText(err))
      setBusy(false)
    }
  }

  const openSettings = (e) => {
    e.preventDefault()
    onOpenSettings()
  }

  if (result) {
    const webhookOk = result.webhook?.status === 'ok'
    const rows = [
      {
        key: 'repo',
        ok: true,
        title: 'Repository connected',
        detail: result.defaultBranch ? `${result.repo}, default branch ${result.defaultBranch}.` : `${result.repo}.`,
      },
      webhookOk
        ? { key: 'webhook', ok: true, title: 'Webhook created', detail: 'GitHub tells Horizon about new issues and pull requests.' }
        : {
            key: 'webhook',
            ok: false,
            title: 'Webhook not created',
            detail: 'Horizon will not hear about new issues and pull requests until it is. Ask the Horizon owner to check it.',
          },
      { key: 'run-user', ok: true, title: 'Run user ready', detail: 'Your agents work in their own isolated space on the server.' },
    ]
    return (
      <section className="connect-repo" aria-labelledby={titleId}>
        <h2 id={titleId} className="connect-repo__title">
          Repository connected
        </h2>
        <p className="connect-repo__lede">
          Horizon can now work in {result.repo}. Set the commands that test it, then file your first item.
        </p>
        <p className="connect-repo__note">Horizon uses this token only for {result.repo}.</p>
        <ul className="connect-repo__results">
          {rows.map((row) => (
            <li key={row.key} className={row.ok ? 'connect-repo__result' : 'connect-repo__result connect-repo__result--warn'}>
              <svg className="connect-repo__result-icon" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="10" cy="10" r="10" />
                {row.ok ? (
                  <path d="M5.5 10.3l3 3 6-6.3" />
                ) : (
                  <path d="M10 5.5v5.5M10 14.2v.3" />
                )}
              </svg>
              <span className="connect-repo__result-text">
                <strong>{row.title}</strong>
                <span>{row.detail}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="connect-repo__actions">
          <a className="connect-repo__primary" href={settingsHref} onClick={openSettings}>
            Set your check commands
          </a>
          <button type="button" className="connect-repo__secondary" onClick={onDone}>
            File your first item
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="connect-repo" aria-labelledby={titleId}>
      <h2 id={titleId} className="connect-repo__title">
        Connect your repository
      </h2>
      <p className="connect-repo__lede">
        Horizon works in your GitHub repository: it plans the change, builds it, tests it and opens the pull request
        there. Connect one to start.
      </p>

      <div className="connect-repo__step connect-repo__step--box">
        <div className="connect-repo__step-head">
          <span className="connect-repo__step-num">1</span>
          <span className="connect-repo__step-title">Create a token on GitHub</span>
        </div>
        <p className="connect-repo__text">
          Use a fine-grained token. Under Repository access choose <strong>Only select repositories</strong> and pick
          just this repository. The link fills in these permissions:
        </p>
        <ul className="connect-repo__chips" aria-label="Token permissions">
          {TOKEN_PERMISSIONS.map((p) => (
            <li key={p.param} className="connect-repo__chip">
              {p.label}
            </li>
          ))}
        </ul>
        <a className="connect-repo__token-link" href={tokenPageUrl(repo)} target="_blank" rel="noopener noreferrer">
          Create a token on GitHub <span aria-hidden="true">↗</span>
        </a>
      </div>

      <form className="connect-repo__step" onSubmit={submit} noValidate>
        <div className="connect-repo__step-head">
          <span className="connect-repo__step-num">2</span>
          <span className="connect-repo__step-title">Connect it</span>
        </div>
        <label className="connect-repo__label" htmlFor={repoId}>
          Repository
        </label>
        <input
          id={repoId}
          className="connect-repo__input"
          type="text"
          placeholder="owner/name"
          autoComplete="off"
          spellCheck={false}
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
        />
        <label className="connect-repo__label" htmlFor={tokenId}>
          Token
        </label>
        <input
          id={tokenId}
          className="connect-repo__input"
          type="password"
          placeholder="github_pat_…"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${tokenId}-hint`}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <span id={`${tokenId}-hint`} className="connect-repo__hint">
          Stored on Horizon's server only. You won't see it again after saving.
        </span>
        {error && (
          <div className="connect-repo__alert" role="alert">
            <strong>{error.text}</strong>
            {error.hint && <span>{error.hint}</span>}
          </div>
        )}
        <button className="connect-repo__submit" type="submit" disabled={busy}>
          {busy ? 'Connecting…' : 'Connect repository'}
        </button>
      </form>
    </section>
  )
}
