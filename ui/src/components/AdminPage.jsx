import { useEffect, useState } from 'react'
import { getDeployTargets, getCheckFlakes } from '../api'
import { BackIcon } from './icons'
import AdminNav from './admin/AdminNav'
import {
  ADMIN_HOME,
  MEMBER_ADMIN_SECTION,
  adminPath,
  isMemberOnlySection,
  isOwnerOnlySection,
  visibleSections,
} from './admin/adminRoutes'
import { AccountSection, GitHubSection } from './admin/AccessSections'
import { DeployTargetsSection, FlakyTestsSection } from './admin/DeliverySections'
import { NeedsAttention, attentionRows } from './admin/NeedsAttention'
import { ProjectPage } from './admin/ProjectPage'
import { NewProjectSection } from './admin/ProjectsSection'
import TenantChecksSection from './admin/TenantChecksSection'
import { useRepoWebhooks } from './admin/useRepoWebhooks'

// HZ-764: how long bare /admin waits for its three reads before it opens on
// the first project anyway. A read still out (or failed) adds no row.
export const LANDING_WAIT_MS = 3000

// HZ-564: Admin is one page at a time, picked from the grouped list on the
// left. App owns the route (parsePath reads `/admin/...`); this shell only
// shows it and asks App to navigate on a click. HZ-660: a member (isOwner
// false) gets only the sections visibleSections allows — an owner-only section
// is never rendered, and its owner-only reads never sent. App passes isOwner;
// the server's 404 on those routes is the real check. HZ-703: a member's own
// check commands are for `activeProject`; the owner never gets that section.
//
// HZ-764: the owner's list is Needs attention, one entry per project, then
// Delivery and Access. Bare /admin opens on Needs attention when it has rows,
// otherwise on the first project (New project when there is none), replacing
// the history entry. `onNavigate(path, { replace })` is App's openAdmin.
// `snapshotReady` is false until the first board frame, when `projects` is
// not yet the real list.
export default function AdminPage({
  sync,
  projects,
  onBack,
  route = ADMIN_HOME,
  onNavigate,
  isOwner = true,
  activeProject = null,
  snapshotReady = true,
}) {
  const [deployTargetsVersion, setDeployTargetsVersion] = useState(0)
  const [deployTargets, setDeployTargets] = useState({ targets: null, error: null })

  // One read of the deploy_target rows per version: the Deploy targets panel
  // lists them, and each repository page uses them to say what a broken
  // webhook breaks (HZ-303). Bumped after each edit in Deploy target overrides.
  useEffect(() => {
    if (!isOwner) return
    getDeployTargets()
      .then((result) => setDeployTargets({ targets: result.targets || [], error: null }))
      .catch((err) => setDeployTargets((prev) => ({ ...prev, error: err.message })))
  }, [deployTargetsVersion, isOwner])

  const [checkFlakes, setCheckFlakes] = useState({ data: null, error: null })
  useEffect(() => {
    if (!isOwner) return
    getCheckFlakes()
      .then((data) => setCheckFlakes({ data: { repos: data.repos || [] }, error: null }))
      .catch((err) => setCheckFlakes({ data: null, error: err.message }))
  }, [isOwner])

  const webhooks = useRepoWebhooks(projects, isOwner)
  // The project Admin opens on: the first real one, before `Unlinked items`.
  const firstProject = projects.find((p) => !p.unlinked) ?? projects[0] ?? null
  const rows = isOwner
    ? attentionRows({ projects, webhooks: webhooks.byProject, flakes: checkFlakes.data, targets: deployTargets.targets })
    : []

  // HZ-764: the landing rule, for the owner's bare /admin only. It waits for
  // the project list, then for the three reads, at most LANDING_WAIT_MS.
  const landing = isOwner && (route.home || isMemberOnlySection(route.section))
  const waiting = landing && (snapshotReady || projects.length > 0)
  const readsSettled =
    (deployTargets.targets !== null || deployTargets.error !== null) &&
    (checkFlakes.data !== null || checkFlakes.error !== null) &&
    webhooks.settled
  const [waitedOut, setWaitedOut] = useState(false)
  useEffect(() => {
    if (!waiting) return undefined
    const timer = setTimeout(() => setWaitedOut(true), LANDING_WAIT_MS)
    return () => {
      clearTimeout(timer)
      setWaitedOut(false)
    }
  }, [waiting])
  const landingPath = !landing
    ? null
    : rows.length > 0
      ? adminPath({ section: 'attention' })
      : adminPath({ section: 'projects', project: firstProject ? firstProject.id : 'new' })
  const landNow = waiting && (readsSettled || waitedOut)
  useEffect(() => {
    if (landNow) onNavigate?.(landingPath, { replace: true })
  }, [landNow, landingPath])

  const section = isOwner
    ? landing
      ? null
      : route.section
    : isOwnerOnlySection(route.section)
      ? MEMBER_ADMIN_SECTION
      : route.section

  // Which project page, if any: /admin/projects alone opens the first.
  const projectRef = section === 'projects' ? (route.project ?? (firstProject ? String(firstProject.id) : 'new')) : null
  const project = projectRef && projectRef !== 'new' ? (projects.find((p) => String(p.id) === projectRef) ?? null) : null
  const active = landing
    ? null
    : section === 'projects'
      ? `project:${projectRef === 'new' ? 'new' : (project?.id ?? projectRef)}`
      : section

  const flakyCount = (checkFlakes.data?.repos || []).reduce((n, r) => n + (r.tests?.length || 0), 0)
  const badges = {
    ...(rows.length > 0 && { attention: { value: rows.length, warn: true } }),
    ...(deployTargets.targets && { deploys: { value: deployTargets.targets.length } }),
    ...(flakyCount > 0 && { flaky: { value: flakyCount, warn: true } }),
  }

  return (
    <div className="admin admin--sections">
      <button className="tracker__back" onClick={onBack}>
        <BackIcon />
        Back to board
      </button>
      <div className="admin-layout">
        <AdminNav
          active={active}
          onSelect={(path) => onNavigate?.(path)}
          badges={badges}
          sections={visibleSections(isOwner)}
          projects={isOwner ? projects : []}
        />
        <main className="admin-section" aria-label="Admin settings">
          {landing && (
            <div className="panel admin__panel">
              <div className="gh-note" role="status">
                Checking for problems…
              </div>
            </div>
          )}
          {section === 'attention' && (
            <NeedsAttention
              rows={rows}
              loading={!readsSettled}
              onRefreshWebhooks={webhooks.refresh}
              onNavigate={onNavigate}
            />
          )}
          {section === 'projects' && projectRef === 'new' && (
            <NewProjectSection
              projects={projects}
              onOpen={(id) => onNavigate?.(adminPath({ section: 'projects', project: id }))}
            />
          )}
          {section === 'projects' && projectRef !== 'new' && project && (
            <ProjectPage
              key={project.id}
              project={project}
              tab={route.tab}
              repo={route.repo}
              syncRepos={sync?.repos}
              webhooks={Object.hasOwn(webhooks.byProject, project.id) ? webhooks.byProject[project.id] : undefined}
              deployTargets={deployTargets.targets}
              onRefreshWebhooks={webhooks.refresh}
              onNavigate={onNavigate}
            />
          )}
          {section === 'projects' && projectRef !== 'new' && !project && (
            <div className="panel admin__panel">
              <h2 className="panel__title">Project not found</h2>
              <div className="gh-note">There is no project {projectRef} you can open. Pick one from the list.</div>
            </div>
          )}
          {section === 'deploys' && (
            <DeployTargetsSection
              targets={deployTargets.targets}
              error={deployTargets.error}
              projects={projects}
              onChanged={() => setDeployTargetsVersion((v) => v + 1)}
            />
          )}
          {section === 'flaky' && <FlakyTestsSection data={checkFlakes.data} error={checkFlakes.error} />}
          {section === 'github' && <GitHubSection sync={sync} />}
          {section === 'account' && <AccountSection />}
          {section === 'checks' && <TenantChecksSection project={activeProject} />}
        </main>
      </div>
    </div>
  )
}
