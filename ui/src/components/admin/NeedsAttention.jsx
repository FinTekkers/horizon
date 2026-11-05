import { WEBHOOK_IMPACT, repoHasDeployTarget, webhookImpact, webhookNeedsFix } from '../../domain/webhookImpact'
import { adminPath } from './adminRoutes'
import { DeployDryRun } from './DeliverySections'
import { FixWebhookForm, WebhookStatus } from './ProjectsSection'

const KIND_LABELS = { webhook: 'Webhook', flaky: 'Flaky tests', deploy: 'Failed deploy' }

// HZ-764: what is broken across the owner's projects, one row each, from three
// reads AdminPage already makes: the webhook map (useRepoWebhooks), the flake
// list and the deploy targets. Pure, so the landing rule and the nav badge use
// the same rows. HZ-657: `projects` is the list the viewer may read, and a
// flake or deploy target counts only when its repo is in one of them. A read
// that is null (loading or failed) adds no row.
export function attentionRows({ projects, webhooks, flakes, targets }) {
  const projectOf = new Map()
  for (const p of projects) for (const r of p.repos) projectOf.set(r.repo.toLowerCase(), { project: p, repo: r.repo })
  const owned = (repo) => (typeof repo === 'string' ? (projectOf.get(repo.toLowerCase()) ?? null) : null)
  const rows = []

  for (const p of projects) {
    const entry = webhooks && Object.hasOwn(webhooks, p.id) ? webhooks[p.id] : null
    const hooks = entry?.webhooks ?? null
    for (const r of p.repos) {
      const webhook = hooks && Object.hasOwn(hooks, r.repo) ? hooks[r.repo] : null
      if (!webhookNeedsFix(webhook)) continue
      const affects = webhookImpact({ status: webhook.status, hasDeployTarget: repoHasDeployTarget(targets, r.repo) }) ?? [
        WEBHOOK_IMPACT.SYNC_CONTINUES,
      ]
      rows.push({ kind: 'webhook', key: `webhook:${p.id}:${r.repo}`, project: p, repo: r.repo, webhook, affects })
    }
  }

  for (const { repo, tests } of flakes?.repos ?? []) {
    const hit = owned(repo)
    const count = Array.isArray(tests) ? tests.length : 0
    if (!hit || count === 0) continue
    rows.push({
      kind: 'flaky',
      key: `flaky:${hit.repo}`,
      project: hit.project,
      repo: hit.repo,
      affects: [`${count} ${count === 1 ? 'test fails' : 'tests fail'} and then ${count === 1 ? 'passes' : 'pass'} on the same code.`],
    })
  }

  for (const target of Array.isArray(targets) ? targets : []) {
    const hit = owned(target?.repo)
    if (!hit || target.lastResult !== 'failed') continue
    rows.push({
      kind: 'deploy',
      key: `deploy:${target.key}`,
      project: hit.project,
      repo: hit.repo,
      target,
      affects: [`The last deploy of ${target.key}${target.lastTag ? ` (${target.lastTag})` : ''} failed, so it is not live.`],
    })
  }
  return rows
}

// HZ-764: Needs attention. Each row says what it affects and has one fix,
// calling the route the same control uses elsewhere in Admin: Fix webhook
// (PIN-gated, then the project's webhooks are re-read), Dry run on the failed
// target, or — flaky tests have no write route — the Flaky tests list.
export function NeedsAttention({ rows, loading = false, onRefreshWebhooks, onNavigate }) {
  const openRepo = (row) => onNavigate?.(adminPath({ section: 'projects', project: row.project.id, repo: row.repo }))
  return (
    <div className="panel admin__panel">
      <h2 className="panel__title">Needs attention</h2>
      <div className="panel__subtitle">
        Broken webhooks, flaky tests and failed deploys across your projects. Each row has its fix.
      </div>
      {rows.length === 0 && (
        <div className="gh-note" role="status">
          {loading ? 'Checking for problems…' : 'Nothing needs attention.'}
        </div>
      )}
      {rows.length > 0 && (
        <ul className="attention-list" aria-label="Needs attention">
          {rows.map((row) => (
            <li key={row.key} className={`attention-row attention-row--${row.kind}`}>
              <div className="attention-row__head">
                <span className="attention-row__kind">{KIND_LABELS[row.kind]}</span>
                <button type="button" className="link-button attention-row__repo" onClick={() => openRepo(row)}>
                  {row.repo}
                </button>
                <span className="attention-row__project">{row.project.name}</span>
                {row.kind === 'webhook' && <WebhookStatus webhook={row.webhook} />}
              </div>
              <div className="attention-row__affects">
                {row.affects.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </div>
              <div className="attention-row__fix">
                {row.kind === 'webhook' && (
                  <FixWebhookForm projectId={row.project.id} repo={row.repo} onFixed={() => onRefreshWebhooks?.(row.project.id)} />
                )}
                {row.kind === 'flaky' && (
                  <button type="button" className="composer__cancel" onClick={() => onNavigate?.(adminPath({ section: 'flaky' }))}>
                    Open flaky tests
                  </button>
                )}
                {row.kind === 'deploy' && (
                  <>
                    <DeployDryRun target={row.target} label="Dry run" />
                    <button type="button" className="link-button" onClick={() => onNavigate?.(adminPath({ section: 'deploys' }))}>
                      Open deploy targets
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
