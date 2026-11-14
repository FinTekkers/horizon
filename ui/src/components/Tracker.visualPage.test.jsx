// HO-862 metric 4: with no `visualPage` on the item no card shows a web-page
// link or thumbnail. With rounds, the link and the latest round's screenshots
// show on the latest round's step card only — the stable link, opened in a new
// tab with no opener or referrer. The Admin switch is unavailable for a tenant
// project.

import { afterEach, expect, test, vi } from 'vitest'
import { render, cleanup, screen, within } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
  pageUrl: (id) => `/horizon/api/items/${id}/page`,
  pageShotUrl: (id, name) => `/horizon/api/items/${id}/page/shots/${name}`,
  subscribeStepOutputs: vi.fn(() => () => {}),
  stopJob: vi.fn(),
  resumeJob: vi.fn(),
  patchRunPlan: vi.fn(),
  setProjectEnabled: vi.fn(),
  setProjectAutopilot: vi.fn(),
  setProjectDefinitionsEnabled: vi.fn(),
  setProjectStepProvider: vi.fn(),
  setProjectVisualPagesEnabled: vi.fn(),
}))

import Tracker from './Tracker'
import { ProjectVisualPages } from './admin/ProjectControls'
import { STEPS, requiredStepIndex } from '../../../domain/js/lifecycle.js'

afterEach(() => cleanup())

const OPTIONS = requiredStepIndex('Plan options & trade-offs (pros / cons)')
const PLAN = requiredStepIndex('Draft implementation plan')
const ARCH = requiredStepIndex('Architecture review')
const round = (n, stepIndex) => ({ round: n, stepIndex, createdAt: '2026-11-20 10:00:00', shots: { desktop: `page-r${n}-desktop.png`, phone: `page-r${n}-phone.png` } })
const noop = () => {}

function renderTracker(visualPage) {
  const done = (index) => ({ output: 'done', attempt: 1, attemptCount: 1, artifact: '## Plan', label: STEPS[index].label })
  return render(
    <Tracker
      item={{
        id: 'HO-900',
        title: 'Checkout mock',
        desc: '',
        metric: '',
        guardrails: '',
        priority: 'Medium',
        cursor: ARCH + 1,
        paused: false,
        rejected: false,
        events: [],
        activeRun: null,
        providerChoices: {},
        ...(visualPage ? { visualPage } : {}),
        stepOutputs: { [OPTIONS]: done(OPTIONS), [PLAN]: done(PLAN), [ARCH]: done(ARCH) },
      }}
      onBack={noop}
      onApprove={noop}
      onApproveWithComments={noop}
      onReject={noop}
      onResolveConflicts={noop}
      onTogglePause={noop}
      onRestartPhase={noop}
      onSetPersona={noop}
      onSetStepProvider={noop}
      onAbandon={noop}
    />,
  )
}

function card(container, index) {
  const label = [...container.querySelectorAll('.step-card__label')].find((el) => el.textContent.startsWith(STEPS[index].label))
  return label.closest('.step-card')
}

test('no visualPage: no card has a web-page link or screenshot', () => {
  const { container } = renderTracker(null)
  expect(screen.queryByRole('link', { name: /View web page/ })).toBeNull()
  expect(screen.queryByRole('img', { name: /Web page round/ })).toBeNull()
  expect(container.querySelector('[data-testid="visual-page"]')).toBeNull()
})

test("two rounds: the link and round 2's screenshots show on the latest round's card only", () => {
  const { container } = renderTracker({ url: '/api/items/HO-900/page', rounds: [round(1, OPTIONS), round(2, PLAN)] })
  const links = screen.getAllByRole('link', { name: /View web page/ })
  expect(links).toHaveLength(1)
  const plan = within(card(container, PLAN))
  const link = plan.getByRole('link', { name: /View web page/ })
  expect(link.getAttribute('href')).toBe('/horizon/api/items/HO-900/page')
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toContain('noopener')
  expect(link.getAttribute('rel')).toContain('noreferrer')
  expect(plan.getByRole('img', { name: 'Web page round 2, desktop screenshot' }).getAttribute('src')).toBe('/horizon/api/items/HO-900/page/shots/page-r2-desktop.png')
  expect(plan.getByRole('img', { name: 'Web page round 2, phone screenshot' }).getAttribute('src')).toBe('/horizon/api/items/HO-900/page/shots/page-r2-phone.png')
  expect(within(card(container, OPTIONS)).queryByRole('link', { name: /View web page/ })).toBeNull()
  expect(screen.queryByRole('img', { name: /round 1/ })).toBeNull()
})

test('the Admin switch is off by default and unavailable for a tenant project', () => {
  render(<ProjectVisualPages project={{ id: 3, name: 'Internal', isolation: 'internal', visualPagesEnabled: false }} />)
  const internal = screen.getByLabelText('Internal web-page visuals')
  expect(internal.checked).toBe(false)
  expect(internal.disabled).toBe(false)
  cleanup()
  render(<ProjectVisualPages project={{ id: 4, name: 'Tenant', isolation: 'tenant', visualPagesEnabled: true }} />)
  const tenant = screen.getByLabelText('Tenant web-page visuals')
  expect(tenant.disabled).toBe(true)
  expect(tenant.checked).toBe(false)
  expect(screen.getByText('Unavailable for tenant projects')).toBeTruthy()
})
