// HZ-711 metric 3: the step list is the control. No Restart phase button and
// no old send-back or restart pop-up render; a phase heading selects its first
// step (aria-current), and every step click opens only the Move dialog, the
// Approve confirm, or nothing. Driven through the real App.

import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { GATE_ITEM, mountApp, stubServer } from './fixtures/stepControl'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetModules()
  window.history.replaceState({}, '', '/')
})

const OLD_POPUPS = /Send back|Restart phase|Request changes|Reject with feedback/

test('no Restart phase button, and a phase heading selects its first step', async () => {
  const server = stubServer()
  await mountApp(server, '/hz-901')
  await screen.findByRole('button', { name: /^Draft implementation plan/ })

  expect(screen.queryByRole('button', { name: /Restart phase/ })).toBeNull()
  expect(document.body.textContent).not.toMatch(OLD_POPUPS)

  const heading = screen.getAllByRole('button').find((b) => b.querySelector('.phase__name')?.textContent === 'Technical Plan')
  fireEvent.click(heading)
  const first = screen.getByRole('button', { name: /^Plan options & trade-offs/ })
  expect(first.getAttribute('aria-current')).toBe('true')
  expect(document.activeElement).toBe(first)
  // Selecting is all a heading does: no dialog opens.
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('alertdialog')).toBeNull()
  // One step is selected at a time.
  expect(document.querySelectorAll('.step-card__select[aria-current="true"]')).toHaveLength(1)
})

test('clicking every step opens no send-back or restart pop-up — only the Move dialog or the Approve confirm', async () => {
  const server = stubServer()
  await mountApp(server, '/hz-901')
  await screen.findByRole('button', { name: /^Draft implementation plan/ })

  const steps = [...document.querySelectorAll('.step-card__select')]
  expect(steps.length).toBeGreaterThan(10)
  const opened = new Set()
  for (const step of steps) {
    fireEvent.click(step)
    expect(step.getAttribute('aria-current')).toBe('true')
    const dialog = screen.queryByRole('dialog') ?? screen.queryByRole('alertdialog')
    if (dialog) {
      expect(dialog.textContent).not.toMatch(OLD_POPUPS)
      opened.add(dialog.querySelector('.composer__title').textContent.split(' · ')[0])
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    }
  }
  expect([...opened].sort()).toEqual(['Approve this gate?', 'Return to an earlier step'])
  // Only the snapshot's targets and the gate open anything.
  const offered = new Set([...GATE_ITEM.moves.targets.map((t) => t.label), GATE_ITEM.moves.approve.label])
  const hinted = steps.filter((s) => s.querySelector('.step-card__hint')).map((s) => s.firstChild.textContent)
  expect(new Set(hinted)).toEqual(offered)
})
