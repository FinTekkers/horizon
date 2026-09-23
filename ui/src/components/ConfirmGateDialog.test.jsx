// HZ-38: gate approvals must be an explicit act, never a silent auto-send.
// These pin the confirm dialog's own contract — the e2e specs cover it
// wired into the app, this covers the component in isolation: it always
// names the real decision, and Enter/Esc behave exactly once each.

import { expect, test, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'

import ConfirmGateDialog from './ConfirmGateDialog'

afterEach(() => {
  cleanup()
})

test('names the actual item and gate, not a generic confirmation', () => {
  const { getByText, queryByText } = render(
    <ConfirmGateDialog itemId="HZ-38" gateLabel="Approve & prioritize this work" onConfirm={() => {}} onCancel={() => {}} />,
  )
  expect(getByText('HZ-38')).toBeTruthy()
  expect(getByText(/Approve & prioritize this work/)).toBeTruthy()
  expect(queryByText(/are you sure/i)).toBeNull()
})

test('pressing Enter confirms exactly once', () => {
  const onConfirm = vi.fn()
  render(<ConfirmGateDialog itemId="HZ-38" gateLabel="Approve gate" onConfirm={onConfirm} onCancel={() => {}} />)
  fireEvent.keyDown(window, { key: 'Enter' })
  expect(onConfirm).toHaveBeenCalledTimes(1)
})

test('pressing Escape cancels and never confirms', () => {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(<ConfirmGateDialog itemId="HZ-38" gateLabel="Approve gate" onConfirm={onConfirm} onCancel={onCancel} />)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(onCancel).toHaveBeenCalledTimes(1)
  expect(onConfirm).not.toHaveBeenCalled()
})

test('clicking Cancel fires onCancel without touching onConfirm', () => {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  const { getByText } = render(
    <ConfirmGateDialog itemId="HZ-38" gateLabel="Approve gate" onConfirm={onConfirm} onCancel={onCancel} />,
  )
  fireEvent.click(getByText('Cancel'))
  expect(onCancel).toHaveBeenCalledTimes(1)
  expect(onConfirm).not.toHaveBeenCalled()
})

test('clicking the scrim cancels, same as clicking Cancel', () => {
  const onCancel = vi.fn()
  const { container } = render(
    <ConfirmGateDialog itemId="HZ-38" gateLabel="Approve gate" onConfirm={() => {}} onCancel={onCancel} />,
  )
  fireEvent.click(container.querySelector('.composer__scrim'))
  expect(onCancel).toHaveBeenCalledTimes(1)
})

test('clicking Approve fires onConfirm exactly once', () => {
  const onConfirm = vi.fn()
  const { getByText } = render(
    <ConfirmGateDialog itemId="HZ-38" gateLabel="Approve gate" onConfirm={onConfirm} onCancel={() => {}} />,
  )
  fireEvent.click(getByText('Approve'))
  expect(onConfirm).toHaveBeenCalledTimes(1)
})
