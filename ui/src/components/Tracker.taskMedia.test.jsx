// HZ-815: the Execute run's stored media shows on the Task's Execute, Verify
// & report and Review & close cards — a <video controls> and an <img>, each
// with its name and size — and with no media (absent or empty) none of the
// three cards has a media section.

import { afterEach, expect, test, vi } from 'vitest'
import { render, cleanup, within } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
  jobLogUrl: (id) => `/horizon/api/items/${id}/job/log?format=text`,
  mediaUrl: (id, name) => `/horizon/api/items/${id}/media/${encodeURIComponent(name)}`,
  subscribeStepOutputs: vi.fn(() => () => {}),
  stopJob: vi.fn(),
  resumeJob: vi.fn(),
  patchRunPlan: vi.fn(),
}))

import Tracker from './Tracker'
import { STEPS, EXECUTE_STEP_INDEX, VERIFY_REPORT_STEP_INDEX, TASK_REVIEW_CLOSE_GATE_INDEX, RUN_PLAN_STEP_INDEX } from '../../../domain/js/lifecycle.js'

afterEach(() => cleanup())

const CARDS = [EXECUTE_STEP_INDEX, VERIFY_REPORT_STEP_INDEX, TASK_REVIEW_CLOSE_GATE_INDEX]
const MEDIA = [
  { name: 'ch1-cut.mp4', path: 'out/ch1-cut.mp4', kind: 'video', mime: 'video/mp4', bytes: 13002342, durationS: 94.2, width: 1920, height: 1080, status: 'stored', reason: null },
  { name: 'poster.jpg', path: 'out/poster.jpg', kind: 'image', mime: 'image/jpeg', bytes: 245760, durationS: null, width: null, height: null, status: 'stored', reason: null },
]
const job = (extra = {}) => ({
  status: 'finished',
  elapsedS: 30,
  budgetS: 600,
  commands: [{ command: 'scripts/cut.sh', status: 'done', exit_code: 0 }],
  logTail: [],
  ...extra,
})
const noop = () => {}

function renderTracker(executeJob) {
  return render(
    <Tracker
      item={{
        id: 'T-815',
        title: 'Cut chapter one',
        desc: '',
        metric: '',
        guardrails: '',
        priority: 'Medium',
        kind: 'task',
        cursor: TASK_REVIEW_CLOSE_GATE_INDEX,
        paused: false,
        rejected: false,
        events: [],
        activeRun: null,
        providerChoices: {},
        stepOutputs: {
          [EXECUTE_STEP_INDEX]: { output: '1 command(s) run', attempt: 1, artifact: 'log', label: STEPS[EXECUTE_STEP_INDEX].label, job: executeJob },
          [VERIFY_REPORT_STEP_INDEX]: { output: 'verified', attempt: 1, artifact: '## Verdict\n**pass**', label: STEPS[VERIFY_REPORT_STEP_INDEX].label, verdict: 'pass' },
        },
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

test('Execute, Verify & report and Review & close each play the video and show the image, with name and size', () => {
  const { container } = renderTracker(job({ media: MEDIA }))
  for (const index of CARDS) {
    const scope = card(container, index)
    const video = within(scope).getByText('ch1-cut.mp4').closest('figure').querySelector('video[controls]')
    expect(video, STEPS[index].label).not.toBeNull()
    expect(video.getAttribute('src')).toBe('/horizon/api/items/T-815/media/ch1-cut.mp4')
    expect(within(scope).getByText('12.4 MB · 1:34 · 1920×1080')).toBeTruthy()
    const img = within(scope).getByText('poster.jpg').closest('figure').querySelector('img')
    expect(img, STEPS[index].label).not.toBeNull()
    expect(within(scope).getByText('240.0 KB')).toBeTruthy()
  }
  // Only those three cards.
  expect(container.querySelectorAll('[data-testid="task-media"]')).toHaveLength(3)
  expect(card(container, RUN_PLAN_STEP_INDEX).querySelector('[data-testid="task-media"]')).toBeNull()
})

test('with media absent or empty, none of the three cards has a media section, video or image', () => {
  for (const executeJob of [job(), job({ media: [] })]) {
    const { container } = renderTracker(executeJob)
    for (const index of CARDS) {
      const scope = card(container, index)
      expect(scope.querySelector('[data-testid="task-media"], video, img')).toBeNull()
    }
    cleanup()
  }
})
