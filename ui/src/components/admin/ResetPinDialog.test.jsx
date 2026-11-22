// HZ-935: Admin's "Reset PIN" opens a dialog to choose your own 6 digits or
// generate a random PIN. Bad input is caught inline with no request; every PIN
// lives only in the dialog and is gone once it closes; nothing is stored.

import { expect, test, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react'
import * as api from '../../api'

vi.mock('../../api', () => ({
  saveToken: vi.fn(),
  regenerateGatePin: vi.fn(),
  setGatePin: vi.fn(),
  lockPinSession: vi.fn(),
  getPinVerifiedUntil: () => null,
  pinSessionLikelyVerified: () => true,
  listApiTokens: vi.fn(async () => ({ tokens: [] })),
  createApiToken: vi.fn(),
  revokeApiToken: vi.fn(),
}))

import { AccountSection } from './AccessSections'

// Made at runtime: no PIN literal is a fixture here.
const randomPin = () => String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000))

let setItem
let writeText
beforeEach(() => {
  setItem = vi.spyOn(Storage.prototype, 'setItem')
  writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

function openDialog() {
  const view = render(<AccountSection />)
  fireEvent.click(view.getByRole('button', { name: 'Reset PIN' }))
  return { ...view, dialog: view.getByRole('dialog') }
}

const fill = (dialog, pin, confirm) => {
  fireEvent.change(within(dialog).getByLabelText('New PIN'), { target: { value: pin } })
  fireEvent.change(within(dialog).getByLabelText('Confirm PIN'), { target: { value: confirm } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Set PIN' }))
}

test('the panel button reads "Reset PIN", no "Regenerate my PIN" remains, and it opens the dialog', () => {
  const { container, getByRole, queryByRole } = render(<AccountSection />)
  expect(container.textContent).not.toMatch(/Regenerate my PIN/)
  expect(container.textContent).not.toMatch(/generated automatically/)
  expect(queryByRole('dialog')).toBeNull()
  fireEvent.click(getByRole('button', { name: 'Reset PIN' }))
  const dialog = getByRole('dialog')
  expect(within(dialog).getByRole('tab', { name: 'Choose my own' }).getAttribute('aria-selected')).toBe('true')
  expect(within(dialog).getByRole('tab', { name: 'Generate random' })).toBeTruthy()
})

test('non-digits, wrong length and a mismatch each show an inline error and send no request', () => {
  const { dialog } = openDialog()
  const pin = randomPin()
  for (const [typed, confirm, message] of [
    [`${pin.slice(0, 5)}a`, `${pin.slice(0, 5)}a`, 'Digits only — 0 to 9.'],
    [pin.slice(0, 5), pin.slice(0, 5), 'Enter exactly 6 digits.'],
    [`${pin}1`, `${pin}1`, 'Enter exactly 6 digits.'],
    [pin, pin === '135792' ? '246813' : '135792', "The two PINs don't match."],
  ]) {
    fill(dialog, typed, confirm)
    expect(within(dialog).getByRole('alert').textContent).toBe(message)
  }
  expect(api.setGatePin).not.toHaveBeenCalled()
  expect(api.regenerateGatePin).not.toHaveBeenCalled()
})

test('a valid chosen PIN is sent once, shows the all-sessions-locked notice, and is never stored', async () => {
  api.setGatePin.mockResolvedValue({ ok: true })
  const { dialog, getByText } = openDialog()
  const pin = randomPin()
  fill(dialog, pin, pin)
  await waitFor(() => expect(within(dialog).getByText(/Your new PIN is set\. Every open session is locked/)).toBeTruthy())
  expect(api.setGatePin).toHaveBeenCalledTimes(1)
  expect(api.setGatePin).toHaveBeenCalledWith(pin, pin)
  expect(dialog.textContent).not.toContain(pin)
  expect(getByText(/PIN not entered in this session/)).toBeTruthy()
  expect(setItem).not.toHaveBeenCalled()
})

test("the server's pin_weak reply shows the weak-PIN message and keeps the dialog open", async () => {
  api.setGatePin.mockRejectedValue(Object.assign(new Error('pin_weak'), { code: 'pin_weak' }))
  const { dialog } = openDialog()
  const pin = randomPin()
  fill(dialog, pin, pin)
  expect(await within(dialog).findByText(/too easy to guess/)).toBeTruthy()
})

test.each([
  ['Escape', () => fireEvent.keyDown(window, { key: 'Escape' })],
  ['Done', (view) => fireEvent.click(within(view.getByRole('dialog')).getByRole('button', { name: 'Done' }))],
  ['the scrim', (view) => fireEvent.click(view.getByTestId('reset-pin-scrim'))],
])('a generated PIN is shown once with Copy, then gone after closing with %s; manual fields reopen empty', async (_name, closeWith) => {
  const pin = randomPin()
  api.regenerateGatePin.mockResolvedValue({ ok: true, pin })
  const view = openDialog()
  const { dialog } = view
  fireEvent.change(within(dialog).getByLabelText('New PIN'), { target: { value: '12' } })
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Generate random' }))
  expect(within(dialog).getByText(/replaces your current PIN straight away/)).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Generate and replace my PIN' }))
  expect((await within(dialog).findByTestId('reset-pin-value')).textContent).toBe(pin)
  expect(within(dialog).getByText(/Shown once, never saved/)).toBeTruthy()
  expect(within(dialog).getByText(/Every open session is locked/)).toBeTruthy()

  await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Copy' })))
  expect(writeText).toHaveBeenCalledWith(pin)

  closeWith(view)
  expect(view.queryByRole('dialog')).toBeNull()
  expect(view.container.textContent).not.toContain(pin)

  fireEvent.click(view.getByRole('button', { name: 'Reset PIN' }))
  const reopened = view.getByRole('dialog')
  expect(reopened.textContent).not.toContain(pin)
  expect(within(reopened).getByLabelText('New PIN').value).toBe('')
  expect(within(reopened).getByLabelText('Confirm PIN').value).toBe('')
  expect(api.regenerateGatePin).toHaveBeenCalledTimes(1)
  expect(setItem).not.toHaveBeenCalled()
})

test('Cancel and unmount drop typed PINs too', () => {
  const pin = randomPin()
  const view = openDialog()
  fireEvent.change(within(view.dialog).getByLabelText('New PIN'), { target: { value: pin } })
  fireEvent.click(within(view.dialog).getByRole('button', { name: 'Cancel' }))
  expect(view.queryByRole('dialog')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Reset PIN' }))
  expect(within(view.getByRole('dialog')).getByLabelText('New PIN').value).toBe('')

  fireEvent.change(within(view.getByRole('dialog')).getByLabelText('New PIN'), { target: { value: pin } })
  view.unmount()
  expect(document.body.innerHTML).not.toContain(pin)
  expect(setItem).not.toHaveBeenCalled()
})
