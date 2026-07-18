import { useState } from 'react'
import { saveToken, createProject, addRepoToProject, disconnectRepo } from '../api'
import { BackIcon, GithubIcon } from './icons'

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
        <span className="admin-status__dot" style={{ background: sync?.tokenConfigured ? '#0E6E74' : '#B9B4C4' }} />
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
        <button className="composer__submit" style={{ background: '#2E6CB2' }} onClick={submit} disabled={busy}>
          {busy ? 'Validating…' : 'Save token'}
        </button>
      </div>
    </div>
  )
}

function RepoRow({ projectId, repoConn, syncRepos }) {
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
        style={{ background: failing ? '#9C333E' : state?.last ? '#0E6E74' : '#B9B4C4' }}
      />
      <a className="repo-row__name" href={`https://github.com/${repoConn.repo}`} target="_blank" rel="noopener noreferrer">
        {repoConn.repo}
      </a>
      <span className="repo-row__prefix">{repoConn.prefix}-*</span>
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

function ProjectPanel({ project, syncRepos }) {
  const [repo, setRepo] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

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
      <div className="project-block__name">{project.name}</div>
      {project.repos.map((r) => (
        <RepoRow key={r.repo} projectId={project.id} repoConn={r} syncRepos={syncRepos} />
      ))}
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

function ProjectsPanel({ projects, sync }) {
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
        <ProjectPanel key={p.id} project={p} syncRepos={sync?.repos} />
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
        <button className="composer__submit" style={{ background: '#2E6CB2' }} onClick={submit} disabled={busy}>
          {busy ? 'Creating…' : 'Create project'}
        </button>
      </div>
      {error && <div className="gh-error">{error}</div>}
    </div>
  )
}

export default function AdminPage({ sync, projects, onBack }) {
  return (
    <div className="admin">
      <button className="tracker__back" onClick={onBack}>
        <BackIcon />
        Back to board
      </button>
      <div className="admin__title">Admin</div>
      <TokenPanel sync={sync} />
      <div style={{ height: 22 }} />
      <ProjectsPanel projects={projects} sync={sync} />
    </div>
  )
}
