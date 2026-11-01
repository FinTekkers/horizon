import { Fragment, useEffect, useState } from 'react'
import { createProject, addRepoToProject, disconnectRepo, getRepoWebhooks, fixRepoWebhook } from '../../api'
import { WEBHOOK_IMPACT, repoHasDeployTarget, webhookImpact } from '../../domain/webhookImpact'
import { ProjectAutopilot, ProjectDefinitions, ProjectEnabledToggle, ProjectStepProviders } from './ProjectControls'
import { RepoChecks, RepoMarks } from './RepoSettings'

// HZ-244: why a webhook row is not plain ok/missing, in a few words.
const WEBHOOK_REASON = {
  foreign_url: 'other host',
  secret_not_configured: 'secret not configured',
  webhook_url_not_public: 'webhook URL not public',
  github_unreachable: 'GitHub unreachable',
  legacy_events: 'no repository events',
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

// HZ-659: Disconnect is gate-PIN protected. Same PIN handling as
// FixWebhookForm: the PIN lives in this form's state only until the request
// settles and goes out in a header.
function DisconnectForm({ projectId, repo, onCancel }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (!pin || busy) return
    setBusy(true)
    setError(null)
    try {
      await disconnectRepo(projectId, repo, pin)
    } catch (err) {
      setError(err.status === 401 ? 'Wrong PIN' : err.message)
    } finally {
      setPin('')
      setBusy(false)
    }
  }

  return (
    <>
      <form className="project-block__add" style={{ marginTop: 0 }} onSubmit={submit}>
        <input
          className="field__input"
          type="password"
          autoComplete="off"
          aria-label={`Gate PIN to disconnect ${repo}`}
          placeholder="Gate PIN to disconnect this repo"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          autoFocus
        />
        <button type="submit" className="composer__submit" style={{ background: 'var(--danger)' }} disabled={!pin || busy}>
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

function RepoRow({ projectId, repoConn, syncRepos, webhook }) {
  const [asking, setAsking] = useState(false)
  const state = syncRepos?.find((r) => r.repo === repoConn.repo)
  const failing = state?.last?.error
  const lastAt = state?.last?.at ? new Date(state.last.at).toLocaleTimeString() : null

  return (
    <>
      <div className="repo-row">
        <span
          className="admin-status__dot"
          style={{ background: failing ? 'var(--danger)' : state?.last ? 'var(--success)' : 'var(--neutral-badge)' }}
        />
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
      {asking && <DisconnectForm projectId={projectId} repo={repoConn.repo} onCancel={() => setAsking(false)} />}
    </>
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
      <ProjectDefinitions project={project} />
      <ProjectStepProviders project={project} />
      {project.repos.map((r) => {
        const webhook = Object.hasOwn(webhooks, r.repo) ? webhooks[r.repo] : null
        return (
          <Fragment key={r.repo}>
            <RepoRow projectId={project.id} repoConn={r} syncRepos={syncRepos} webhook={webhook} />
            <WebhookImpact status={webhook?.status} hasDeployTarget={repoHasDeployTarget(deployTargets, r.repo)} />
            {(webhook?.status === 'missing' || webhook?.status === 'mismatched' || webhook?.reason === 'legacy_events') && (
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

export function ProjectsSection({ projects, sync, deployTargets }) {
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
      <h2 className="panel__title">Projects</h2>
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
