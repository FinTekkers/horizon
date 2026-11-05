import { useId } from 'react'
import { DEFAULT_PROVIDER, PROVIDERS } from '../../../../domain/js/providers.js'
import { PROJECT_TABS, adminPath } from './adminRoutes'
import { ProjectAutopilot, ProjectDefinitions, ProjectEnabledToggle, ProjectStepProviders } from './ProjectControls'
import { AddRepoForm, RepoListRow } from './ProjectsSection'
import { RepoPage } from './RepoPage'

const TAB_LABELS = { repositories: 'Repositories', automation: 'Automation', agents: 'Agents', settings: 'Settings' }

const DEFAULT_PROVIDER_LABEL = PROVIDERS.find((p) => p.name === DEFAULT_PROVIDER)?.label ?? DEFAULT_PROVIDER

// HZ-764: one project, as tabs at their own URLs. Every control here is the one
// the old all-projects list used, moved and not rewritten. A repository's page
// opens under the Repositories tab. `webhooks` is this project's entry from
// useRepoWebhooks ({ webhooks, error }), or undefined while it loads.
export function ProjectPage({ project, tab, repo, syncRepos, webhooks, deployTargets, onRefreshWebhooks, onNavigate }) {
  const id = useId()
  const open = tab ?? PROJECT_TABS[0]
  const go = (to) => onNavigate?.(adminPath({ section: 'projects', project: project.id, ...to }))
  const webhookOf = (name) => (webhooks?.webhooks && Object.hasOwn(webhooks.webhooks, name) ? webhooks.webhooks[name] : null)

  return (
    <section className="panel admin__panel project-block project-page" aria-labelledby={`${id}-name`}>
      <h2 className="panel__title project-block__name" id={`${id}-name`}>
        {project.name}
      </h2>
      <div className="project-tabs" role="tablist" aria-label={`${project.name} pages`}>
        {PROJECT_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`${id}-${t}`}
            aria-selected={t === open}
            aria-controls={`${id}-panel`}
            className={`project-tabs__tab${t === open ? ' project-tabs__tab--on' : ''}`}
            onClick={() => go({ tab: t })}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      <div className="project-page__panel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${open}`}>
        {open === 'repositories' && repo != null && (
          <RepoPage
            key={repo}
            project={project}
            repo={repo}
            syncRepos={syncRepos}
            webhook={webhookOf(repo)}
            webhooksError={webhooks?.error ?? null}
            deployTargets={deployTargets}
            onRefreshWebhooks={onRefreshWebhooks}
            onNavigate={onNavigate}
          />
        )}
        {open === 'repositories' && repo == null && (
          <>
            {project.repos.length > 0 && (
              <ul className="repo-list" aria-label={`${project.name} repositories`}>
                {project.repos.map((r) => (
                  <RepoListRow
                    key={r.repo}
                    repoConn={r}
                    syncRepos={syncRepos}
                    webhook={webhookOf(r.repo)}
                    onOpen={() => go({ repo: r.repo })}
                  />
                ))}
              </ul>
            )}
            {webhooks?.error && <div className="gh-error">Webhook status unavailable: {webhooks.error}</div>}
            {project.repos.length === 0 && <div className="gh-note">No repositories connected yet.</div>}
            <AddRepoForm project={project} />
          </>
        )}
        {open === 'automation' && <ProjectAutopilot project={project} />}
        {open === 'agents' && (
          <>
            <div className="project-page__line">
              Default provider: <strong>{DEFAULT_PROVIDER_LABEL}</strong>. Steps not listed under Runs on use it.
            </div>
            <ProjectDefinitions project={project} />
            <ProjectStepProviders project={project} onlyOverrides />
          </>
        )}
        {open === 'settings' && (
          <>
            <div className="project-block__head">
              <span className="project-page__label">Dispatch</span>
              <ProjectEnabledToggle project={project} />
            </div>
            <ProjectStepProviders project={project} />
            <ProjectIsolation project={project} />
          </>
        )}
      </div>
    </section>
  )
}

// Read-only: there is no Admin control for isolation (it is set outside the
// UI). Names the run user and token reference only for a tenant project.
function ProjectIsolation({ project }) {
  if (!project.isolation) return null
  return (
    <dl className="project-page__facts" aria-label={`${project.name} isolation`}>
      <dt>Isolation</dt>
      <dd>{project.isolation}</dd>
      {project.isolation === 'tenant' && (
        <>
          <dt>Run user</dt>
          <dd>{project.runUser ?? 'not set'}</dd>
          <dt>GitHub token</dt>
          <dd>{project.githubTokenRef ?? 'not set'}</dd>
        </>
      )}
    </dl>
  )
}
