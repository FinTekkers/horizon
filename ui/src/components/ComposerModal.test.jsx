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

// ---- abandon (HZ-59): the one mode where a reason is not optional ----

const abandonComposer = { open: true, mode: 'abandon', itemId: 'HZ-59' }

test('abandon mode blocks submission with a blank reason', () => {
  const onSubmit = vi.fn()
  const { getByText } = render(<ComposerModal composer={abandonComposer} onSubmit={onSubmit} onCancel={() => {}} />)
  fireEvent.click(getByText('Abandon'))
  expect(onSubmit).not.toHaveBeenCalled()
})

test('abandon mode blocks submission when the reason is only whitespace', () => {
  const onSubmit = vi.fn()
  const { container, getByText } = render(
    <ComposerModal composer={abandonComposer} onSubmit={onSubmit} onCancel={() => {}} />,
  )
  fireEvent.change(container.querySelector('.composer__input'), { target: { value: '   ' } })
  fireEvent.click(getByText('Abandon'))
  expect(onSubmit).not.toHaveBeenCalled()
})

test('abandon mode submits the trimmed reason once one is entered', () => {
  const onSubmit = vi.fn()
  const { container, getByText } = render(
    <ComposerModal composer={abandonComposer} onSubmit={onSubmit} onCancel={() => {}} />,
  )
  fireEvent.change(container.querySelector('.composer__input'), { target: { value: '  duplicate of HZ-12  ' } })
  fireEvent.click(getByText('Abandon'))
  expect(onSubmit).toHaveBeenCalledWith('duplicate of HZ-12', { removeDependentLinks: false })
})

// ---- HZ-354: abandon lists what the item blocks, with "Remove these links" ----

const abandonBlocker = {
  open: true,
  mode: 'abandon',
  itemId: 'LS-38',
  dependents: [
    { id: 'LS-17', title: 'Waits on LS-38', abandoned: false },
    { id: 'LS-20', title: 'Also waits', abandoned: false },
  ],
}

function abandonWith(composer, onSubmit) {
  const utils = render(<ComposerModal composer={composer} onSubmit={onSubmit} onCancel={() => {}} />)
  fireEvent.change(utils.container.querySelector('.composer__input'), { target: { value: 'superseded' } })
  return utils
}

test('abandon lists every item this one blocks, with "Remove these links" checked by default', () => {
  const onSubmit = vi.fn()
  const { getByText, getByRole } = abandonWith(abandonBlocker, onSubmit)
  expect(getByText('LS-17 — Waits on LS-38')).toBeTruthy()
  expect(getByText('LS-20 — Also waits')).toBeTruthy()
  expect(getByRole('checkbox', { name: 'Remove these links' }).checked).toBe(true)
  fireEvent.click(getByText('Abandon'))
  expect(onSubmit).toHaveBeenCalledWith('superseded', { removeDependentLinks: true })
})

test('unchecking "Remove these links" submits removeDependentLinks: false', () => {
  const onSubmit = vi.fn()
  const { getByText, getByRole } = abandonWith(abandonBlocker, onSubmit)
  fireEvent.click(getByRole('checkbox', { name: 'Remove these links' }))
  fireEvent.click(getByText('Abandon'))
  expect(onSubmit).toHaveBeenCalledWith('superseded', { removeDependentLinks: false })
})

test('abandoning an item that blocks nothing shows no "Remove these links" option', () => {
  const onSubmit = vi.fn()
  const { getByText, queryByRole } = abandonWith({ ...abandonBlocker, dependents: [] }, onSubmit)
  expect(queryByRole('checkbox')).toBeNull()
  expect(queryByRole('checkbox', { name: 'Remove these links' })).toBeNull()
  fireEvent.click(getByText('Abandon'))
  expect(onSubmit).toHaveBeenCalledWith('superseded', { removeDependentLinks: false })
})

// ---- send-back-to-a-chosen-step picker (HZ-51) ----

const rejectWithOptions = {
  open: true,
  mode: 'reject',
  itemId: 'HZ-51',
  target: 'Review before execution',
  stepOptions: [
    { index: 6, label: 'Draft implementation plan' },
    { index: 7, label: 'Architecture review' },
    { index: 9, label: 'Summarize reviews & recommend' },
  ],
  defaultTargetLabel: 'Summarize reviews & recommend',
}

test('a reject from a gate with eligible earlier steps shows the destination picker', () => {
  const { getByText, getByLabelText } = render(
    <ComposerModal composer={rejectWithOptions} onSubmit={() => {}} onCancel={() => {}} />,
  )
  expect(getByLabelText('Send back to')).toBeTruthy()
  expect(getByText('Draft implementation plan')).toBeTruthy()
  expect(getByText(/Default — Summarize reviews & recommend/)).toBeTruthy()
})

test('a reject with no eligible earlier steps (or a non-reject mode) renders no picker', () => {
  const { queryByLabelText } = render(
    <ComposerModal
      composer={{ open: true, mode: 'reject', itemId: 'HZ-51', target: 'x', stepOptions: [] }}
      onSubmit={() => {}}
      onCancel={() => {}}
    />,
  )
  expect(queryByLabelText('Send back to')).toBeNull()
})

test('submitting without touching the picker sends null — the default (no-target) path', () => {
  const onSubmit = vi.fn()
  const { container, getByText } = render(
    <ComposerModal composer={rejectWithOptions} onSubmit={onSubmit} onCancel={() => {}} />,
  )
  fireEvent.change(container.querySelector('.composer__input'), { target: { value: 'redo this' } })
  fireEvent.click(getByText('Send back'))
  expect(onSubmit).toHaveBeenCalledWith('redo this', null)
})

test('picking a step in the dropdown sends its index as the explicit target', () => {
  const onSubmit = vi.fn()
  const { container, getByLabelText, getByText } = render(
    <ComposerModal composer={rejectWithOptions} onSubmit={onSubmit} onCancel={() => {}} />,
  )
  fireEvent.change(getByLabelText('Send back to'), { target: { value: '6' } })
  fireEvent.change(container.querySelector('.composer__input'), { target: { value: 'missed the migration step' } })
  fireEvent.click(getByText('Send back'))
  expect(onSubmit).toHaveBeenCalledWith('missed the migration step', 6)
})

test('approve mode calls onSubmit with a single argument, unaffected by the reject-only picker', () => {
  const onSubmit = vi.fn()
  const { getByText } = render(<ComposerModal composer={composer} onSubmit={onSubmit} onCancel={() => {}} />)
  fireEvent.click(getByText('Approve'))
  expect(onSubmit).toHaveBeenCalledWith('')
})
