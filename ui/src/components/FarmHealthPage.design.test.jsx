// HZ-969 metrics 1-4, on the page: Farm health's Design steps section, drawn
// by the whole FarmHealthPage from a snapshot shaped like GET
// /api/admin/farm-health's (the mock API's fixture, with its design block
// replaced per case).

import { expect, test, afterEach } from 'vitest'
import { render, cleanup, within, screen } from '@testing-library/react'
import { getFarmHealth } from '../api/mockApi'
import FarmHealthPage from './FarmHealthPage'

afterEach(cleanup)

const AT = '2026-11-22T10:42:00Z'
const PROBE_FAILED = { state: 'failed', checkedAt: AT, label: 'needs `/design-login`', fresh: true }
const PROJECTS = [
  { name: 'Horizon', file: 'farm/projects/horizon/steps.json', definitions: 'on', design: 'on', label: 'Design the screens', repos: ['FinTekkers/horizon'], labels: [], paths: [] },
  { name: 'UI Service', file: null, definitions: 'on', design: 'off', label: null, repos: [], labels: [], paths: [] },
]
const BASE = {
  status: 'ok',
  chosen: 'studio',
  tool: 'html',
  fallbackFrom: 'studio',
  reason: 'Meta Studio (`meta`) is not installed on this box',
  htmlReady: true,
  htmlReason: null,
  probe: PROBE_FAILED,
  maxAgeS: 7 * 86400,
  projectsStatus: 'ok',
  projects: PROJECTS,
  roundsStatus: 'ok',
  rounds: [],
}

async function renderDesign(design) {
  const data = { ...(await getFarmHealth()), design: { ...BASE, ...design } }
  render(<FarmHealthPage health={{ data, error: null, loading: false }} onRefresh={() => {}} onOpenItem={() => {}} />)
  return screen.getByRole('region', { name: 'Design steps' })
}

const toolLine = (section) => within(within(section).getByRole('region', { name: 'Tool in use' })).getByTestId('farm-health-design-tool')

test('metric 1: Studio chosen with no meta names Studio, Horizon pages and the reason', async () => {
  const section = await renderDesign({})
  expect(toolLine(section).textContent).toBe('Studio chosen, meta not installed → drawing Horizon pages')
  const tool = within(section).getByRole('region', { name: 'Tool in use' })
  expect(tool.textContent).toContain('Meta Studio (meta) is not installed on this box')
  expect(tool.textContent).toContain('Rounds useHorizon pages')
})

test('metric 1: a missing capture worker is said on the tool row', async () => {
  const section = await renderDesign({ htmlReady: false, htmlReason: 'the farm capture worker is not installed (cd farm/capture && npm ci)' })
  expect(toolLine(section).textContent).toContain('but the capture worker is missing')
  expect(within(section).getByRole('region', { name: 'Tool in use' }).textContent).toContain('the farm capture worker is not installed')
})

test('metric 2: a failed probe shows its time and label, and the tool row never reads Claude Design', async () => {
  const section = await renderDesign({ chosen: 'claude', fallbackFrom: 'claude', reason: 'the Claude Design probe failed: needs `/design-login`' })
  const probe = within(section).getByRole('region', { name: 'Claude Design probe' })
  expect(probe.textContent).toContain('22 Nov, 10:42 UTC')
  expect(probe.textContent).toContain('needs /design-login')
  expect(within(probe).getByText('Failed')).toBeTruthy()
  expect(toolLine(section).textContent).toBe('Claude chosen, probe failed → drawing Horizon pages')
  expect(toolLine(section).textContent).not.toContain('Claude Design')
})

test('metric 2: a stale probe reads older than 7 days, and the tool row never reads Claude Design', async () => {
  const section = await renderDesign({
    chosen: 'claude',
    fallbackFrom: 'claude',
    reason: 'the Claude Design probe on this box is out of date; run it again',
    probe: { state: 'passed', checkedAt: '2026-11-13T14:10:00Z', label: null, fresh: false },
  })
  const probe = within(section).getByRole('region', { name: 'Claude Design probe' })
  expect(probe.textContent).toContain('13 Nov, 14:10 UTC')
  expect(probe.textContent).toContain('older than 7 days')
  expect(toolLine(section).textContent).not.toContain('Claude Design')
})

test('metric 2: a fresh passed probe with claude chosen reads Claude Design', async () => {
  const section = await renderDesign({
    chosen: 'claude',
    tool: 'claude',
    fallbackFrom: null,
    reason: null,
    probe: { state: 'passed', checkedAt: '2026-11-20T09:00:00Z', label: null, fresh: true },
  })
  expect(toolLine(section).textContent).toBe('Claude chosen → drawing with Claude Design')
})

test('metric 3: the design project lists its repo and the other reads off', async () => {
  const section = await renderDesign({})
  const projects = within(section).getByRole('region', { name: 'Projects with the design sub-step' })
  const [horizon, ui] = within(projects).getAllByRole('row').slice(1)
  expect(horizon.textContent).toContain('FinTekkers/horizon')
  expect(within(horizon).getByText('On')).toBeTruthy()
  expect(within(ui).getByText('Off')).toBeTruthy()
  expect(ui.textContent).not.toContain('FinTekkers/horizon')
  expect(projects.textContent).toContain('1 of 2 on')
})

test('metric 4: rounds read ran and skipped with item, tool and why; none reads No design rounds yet', async () => {
  let section = await renderDesign({
    rounds: [
      { itemId: 'HZ-969', round: 1, kind: 'run', tool: 'html', fallbackFrom: 'studio', why: '`meta` not installed', at: '2026-11-22T12:31:00Z' },
      { itemId: 'US-327', round: 1, kind: 'skip', tool: null, fallbackFrom: null, why: 'No UI change', at: '2026-11-22T11:05:00Z' },
    ],
  })
  const rounds = within(section).getByRole('region', { name: 'Last design rounds' })
  const [ran, skipped] = within(rounds).getAllByRole('row').slice(1)
  expect(within(ran).getByRole('link', { name: 'HZ-969' })).toBeTruthy()
  expect(ran.textContent).toContain('Horizon page')
  expect(ran.textContent).toContain('fell back from Studio')
  expect(within(ran).getByText('Ran')).toBeTruthy()
  expect(ran.textContent).toContain('meta not installed')
  expect(within(skipped).getByRole('link', { name: 'US-327' })).toBeTruthy()
  expect(skipped.textContent).toContain('None')
  expect(within(skipped).getByText('Skipped')).toBeTruthy()
  expect(skipped.textContent).toContain('No UI change')
  cleanup()

  section = await renderDesign({ rounds: [] })
  expect(within(within(section).getByRole('region', { name: 'Last design rounds' })).getByText('No design rounds yet.')).toBeTruthy()
})

test('an unknown design reading reads Design status unknown in this section only', async () => {
  const section = await renderDesign({ status: 'unknown', chosen: null, tool: null, fallbackFrom: null, probe: {} })
  expect(section.textContent).toContain('Design status unknown')
  expect(screen.getByRole('region', { name: 'Overall' })).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Services' })).toBeTruthy()
})
