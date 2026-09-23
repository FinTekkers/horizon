// HZ-38: this is the "already types, now must also confirm" surface —
// approve-with-comments, send-back, and restart all route through here.
// The guardrail is "Enter confirms, Esc cancels"; since the textarea needs
// plain Enter for newlines, the explicit confirm keystroke is Ctrl/Cmd+Enter
// instead. These pin that keyboard contract plus the itemId-in-title fix.

import { expect, test, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'

import ComposerModal from './ComposerModal'

afterEach(() => {
  cleanup()
})

const composer = { open: true, mode: 'approve', itemId: 'HZ-38', target: 'Approve & prioritize this work' }

test('title names the actual item, not a generic confirmation', () => {
  const { getByText } = render(<ComposerModal composer={composer} onSubmit={() => {}} onCancel={() => {}} />)
  expect(getByText(/HZ-38/)).toBeTruthy()
})

test('Ctrl+Enter submits exactly once with the typed notes', () => {
  const onSubmit = vi.fn()
  const { container } = render(<ComposerModal composer={composer} onSubmit={onSubmit} onCancel={() => {}} />)
  fireEvent.change(container.querySelector('.composer__input'), { target: { value: 'looks good' } })
  fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
  expect(onSubmit).toHaveBeenCalledTimes(1)
  expect(onSubmit).toHaveBeenCalledWith('looks good')
})

test('Cmd+Enter (metaKey) submits exactly once', () => {
  const onSubmit = vi.fn()
  render(<ComposerModal composer={composer} onSubmit={onSubmit} onCancel={() => {}} />)
  fireEvent.keyDown(window, { key: 'Enter', metaKey: true })
  expect(onSubmit).toHaveBeenCalledTimes(1)
})

test('plain Enter (no modifier) does not submit', () => {
  const onSubmit = vi.fn()
  render(<ComposerModal composer={composer} onSubmit={onSubmit} onCancel={() => {}} />)
  fireEvent.keyDown(window, { key: 'Enter' })
  expect(onSubmit).not.toHaveBeenCalled()
})

test('pressing Escape cancels and never submits', () => {
  const onSubmit = vi.fn()
  const onCancel = vi.fn()
  render(<ComposerModal composer={composer} onSubmit={onSubmit} onCancel={onCancel} />)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(onCancel).toHaveBeenCalledTimes(1)
  expect(onSubmit).not.toHaveBeenCalled()
})

test('clicking Cancel fires onCancel without touching onSubmit', () => {
  const onSubmit = vi.fn()
  const onCancel = vi.fn()
  const { getByText } = render(<ComposerModal composer={composer} onSubmit={onSubmit} onCancel={onCancel} />)
  fireEvent.click(getByText('Cancel'))
  expect(onCancel).toHaveBeenCalledTimes(1)
  expect(onSubmit).not.toHaveBeenCalled()
})

test('clicking the submit button fires onSubmit exactly once', () => {
  const onSubmit = vi.fn()
  const { getByText } = render(<ComposerModal composer={composer} onSubmit={onSubmit} onCancel={() => {}} />)
  fireEvent.click(getByText('Approve'))
  expect(onSubmit).toHaveBeenCalledTimes(1)
})
