import { useEffect, useState } from 'react'
import { getDeployTargets, getCheckFlakes } from '../api'
import { BackIcon } from './icons'
import AdminNav from './admin/AdminNav'
import { ADMIN_HOME, adminPath } from './admin/adminRoutes'
import { AccountSection, GitHubSection } from './admin/AccessSections'
import { DeployTargetsSection, FlakyTestsSection } from './admin/DeliverySections'
import { ProjectsSection } from './admin/ProjectsSection'

// HZ-564: Admin is one section at a time, picked from the grouped list on the
// left. App owns the route (parsePath reads `/admin/<section>`); this shell
// only shows it and asks App to navigate on a click.
export default function AdminPage({ sync, projects, onBack, route = ADMIN_HOME, onNavigate }) {
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

  const section = route.section
  const flakyCount = (checkFlakes.data?.repos || []).reduce((n, r) => n + (r.tests?.length || 0), 0)
  const badges = {
    projects: { value: projects.length },
    ...(deployTargets.targets && { deploys: { value: deployTargets.targets.length } }),
    ...(flakyCount > 0 && { flaky: { value: flakyCount, warn: true } }),
  }
  const extraTerms = { projects: projects.flatMap((p) => [p.name, ...p.repos.map((r) => r.repo)]) }

  return (
    <div className="admin admin--sections">
      <button className="tracker__back" onClick={onBack}>
        <BackIcon />
        Back to board
      </button>
      <div className="admin-layout">
        <AdminNav
          section={section}
          onSelect={(key) => onNavigate?.(adminPath({ section: key }))}
          badges={badges}
          extraTerms={extraTerms}
        />
        <main className="admin-section" aria-label="Admin settings">
          {section === 'projects' && (
            <ProjectsSection projects={projects} sync={sync} deployTargets={deployTargets.targets} />
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
        </main>
      </div>
    </div>
  )
}
