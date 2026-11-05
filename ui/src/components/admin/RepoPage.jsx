import { repoHasDeployTarget, webhookNeedsFix } from '../../domain/webhookImpact'
import { adminPath } from './adminRoutes'
import { FixWebhookForm, RepoRow, WebhookImpact } from './ProjectsSection'
import { RepoChecks, RepoMarks } from './RepoSettings'

// HZ-764: one repository's page, at /admin/projects/<id>/repos/<owner>/<name>.
// Its settings are the controls the old project list showed under each repo,
// unchanged: check commands and the test login (RepoChecks), No checks / No
// deploy, a link to its deploy target, and Disconnect. Fix webhook and what a
// broken hook breaks show only while the hook needs fixing.
export function RepoPage({ project, repo, syncRepos, webhook, webhooksError, deployTargets, onRefreshWebhooks, onNavigate }) {
  const repoConn = project.repos.find((r) => r.repo.toLowerCase() === repo.toLowerCase())
  const backToRepos = () => onNavigate?.(adminPath({ section: 'projects', project: project.id }))

  if (!repoConn) {
    return (
      <div className="repo-page">
        <h3 className="repo-page__title">Repository not connected</h3>
        <div className="gh-note">
          {repo} is not connected to {project.name}.{' '}
          <button type="button" className="link-button" onClick={backToRepos}>
            Back to {project.name} repositories
          </button>
        </div>
      </div>
    )
  }

  const hasDeployTarget = repoHasDeployTarget(deployTargets, repoConn.repo)
  return (
    <div className="repo-page">
      <div className="repo-page__crumbs">
        <button type="button" className="link-button" onClick={backToRepos}>
          Repositories
        </button>
        <span aria-hidden="true"> › </span>
        <h3 className="repo-page__title">{repoConn.repo}</h3>
      </div>
      <RepoRow projectId={project.id} repoConn={repoConn} syncRepos={syncRepos} webhook={webhook} onDisconnected={backToRepos} />
      <WebhookImpact status={webhook?.status} hasDeployTarget={hasDeployTarget} />
      {webhookNeedsFix(webhook) && (
        <FixWebhookForm projectId={project.id} repo={repoConn.repo} onFixed={() => onRefreshWebhooks?.(project.id)} />
      )}
      {webhooksError && <div className="gh-error">Webhook status unavailable: {webhooksError}</div>}
      <RepoMarks projectId={project.id} repoConn={repoConn} />
      {hasDeployTarget && (
        <div className="repo-page__deploy">
          Deploys on release.{' '}
          <button type="button" className="link-button" onClick={() => onNavigate?.(adminPath({ section: 'deploys' }))}>
            Open its deploy target
          </button>
        </div>
      )}
      <RepoChecks projectId={project.id} repoConn={repoConn} />
    </div>
  )
}
