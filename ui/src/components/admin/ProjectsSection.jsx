import { useEffect, useState } from 'react'
import { createProject, addRepoToProject, disconnectRepo, fixRepoWebhook } from '../../api'
import { WEBHOOK_IMPACT, webhookImpact } from '../../domain/webhookImpact'

// HZ-764: the pieces of a project's pages — ProjectPage.jsx lays out its tabs
// and RepoPage.jsx one repository; Needs attention reuses FixWebhookForm.

// HZ-244: why a webhook row is not plain ok/missing, in a few words.
const WEBHOOK_REASON = {
  foreign_url: 'other host',
  secret_not_configured: 'secret not configured',
  webhook_url_not_public: 'webhook URL not public',
  github_unreachable: 'GitHub unreachable',
  legacy_events: 'no repository events',
}

export function WebhookStatus({ webhook }) {
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
export function WebhookImpact({ status, hasDeployTarget }) {
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
// mismatched one. Confirmed like ProjectEnabledToggle; the PIN dialog asks for
// the gate PIN only when the session is not PIN-verified (HZ-704).
export function FixWebhookForm({ projectId, repo, onFixed }) {
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

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
      await fixRepoWebhook(projectId, repo)
      setAsking(false)
      onFixed?.()
    } catch (err) {
      setError(err.message === 'pin_needed' ? 'Gate PIN needed — nothing was saved' : err.message)
    } finally {
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
        <button type="submit" className="composer__submit" style={{ background: 'var(--primary)' }} disabled={busy}>
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

// HZ-659: Disconnect is gate-PIN protected, like FixWebhookForm. HZ-764:
// `onDisconnected` lets the repository page go back to its project.
export function DisconnectForm({ projectId, repo, onCancel, onDisconnected }) {
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await disconnectRepo(projectId, repo)
      onDisconnected?.()
    } catch (err) {
      setError(err.message === 'pin_needed' ? 'Gate PIN needed — nothing was changed' : err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <form className="project-block__add" style={{ marginTop: 0 }} onSubmit={submit}>
        <button type="submit" className="composer__submit" style={{ background: 'var(--danger)' }} disabled={busy}>
          {busy ? 'Disconnecting…' : 'Disconnect'}
        </button>
        <button type="button" className="composer__cancel" onClick={onCancel}>
          Cancel
        </button>
      </form>
      {error && <div className="gh-error">{error}</div>}
    </>
  )
}

// The repository page's header row: the GitHub link, prefix, default branch,
// webhook, sync state, and Disconnect.
export function RepoRow({ projectId, repoConn, syncRepos, webhook, onDisconnected }) {
  const [asking, setAsking] = useState(false)
  const state = syncRepos?.find((r) => r.repo === repoConn.repo)
  const failing = state?.last?.error
  const lastAt = state?.last?.at ? new Date(state.last.at).toLocaleTimeString() : null

  return (
    <>
      <div className="repo-row">
        <SyncDot state={state} />
        <a className="repo-row__name" href={`https://github.com/${repoConn.repo}`} target="_blank" rel="noopener noreferrer">
          {repoConn.repo}
        </a>
        <span className="repo-row__prefix">{repoConn.prefix}-*</span>
        <span className="repo-row__branch">
          default branch: {repoConn.defaultBranch ?? 'not read yet'}
        </span>
        {webhook && <WebhookStatus webhook={webhook} />}
        <span className="repo-row__status">
          {failing ? failing : lastAt ? `checked ${lastAt}` : 'waiting for first poll'}
        </span>
        <button
          className="repo-row__disconnect"
          title="Disconnect this repository (stops sync; existing items keep their history)"
          aria-label={`Disconnect ${repoConn.repo}`}
          onClick={() => setAsking(true)}
          disabled={asking}
        >
          ✕
        </button>
      </div>
      {asking && (
        <DisconnectForm
          projectId={projectId}
          repo={repoConn.repo}
          onCancel={() => setAsking(false)}
          onDisconnected={onDisconnected}
        />
      )}
    </>
  )
}

function SyncDot({ state }) {
  const failing = state?.last?.error
  return (
    <span
      className="admin-status__dot"
      style={{ background: failing ? 'var(--danger)' : state?.last ? 'var(--success)' : 'var(--neutral-badge)' }}
    />
  )
}

// HZ-764: one compact row on a project's Repositories tab. The name opens the
// repository's own page, where its settings live.
export function RepoListRow({ repoConn, syncRepos, webhook, onOpen }) {
  const state = syncRepos?.find((r) => r.repo === repoConn.repo)
  const failing = state?.last?.error
  const lastAt = state?.last?.at ? new Date(state.last.at).toLocaleTimeString() : null
  return (
    <li className="repo-row repo-row--list">
      <SyncDot state={state} />
      <button type="button" className="repo-row__name repo-row__open" onClick={onOpen}>
        {repoConn.repo}
      </button>
      <span className="repo-row__prefix">{repoConn.prefix}-*</span>
      <span className="repo-row__branch">
        default branch: {repoConn.defaultBranch ?? 'not read yet'}
      </span>
      {webhook && <WebhookStatus webhook={webhook} />}
      <span className="repo-row__status">
        {failing ? failing : lastAt ? `checked ${lastAt}` : 'waiting for first poll'}
      </span>
    </li>
  )
}

// The Repositories tab's Connect form: adds a repo to this project.
export function AddRepoForm({ project }) {
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
    <>
      <div className="project-block__add">
        <input
          className="field__input"
          placeholder="Add a repo: owner/name or URL"
          aria-label={`Add a repo to ${project.name}`}
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button className="composer__cancel" onClick={submit} disabled={busy}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
      {error && <div className="gh-error">{error}</div>}
    </>
  )
}

// HZ-764: Projects › New project — the Create project form on its own page.
// Once the board snapshot carries the new project, `onOpen(id)` opens it.
export function NewProjectSection({ projects = [], onOpen }) {
  const [name, setName] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState(null)

  useEffect(() => {
    if (created != null && projects.some((p) => p.id === created)) onOpen?.(created)
  }, [created, projects])

  const submit = async () => {
    if (name.trim().length < 2) return
    setBusy(true)
    setError(null)
    try {
      const result = await createProject(name.trim())
      setName('')
      if (result?.id != null) setCreated(result.id)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel admin__panel">
      <h2 className="panel__title">New project</h2>
      <div className="panel__subtitle">
        A project is what the board tracks; it can span several repositories. Issues from every connected repo
        become work items (IDs use the repo's prefix, e.g. SH-12). The Execute step opens the PR in the item's own
        repo.
      </div>

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
