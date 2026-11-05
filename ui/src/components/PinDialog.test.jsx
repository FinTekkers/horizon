// HZ-704 metric 2: one in-page PIN dialog serves every PIN-protected change.
// It opens for the first change, not for the second (the server session is
// now PIN-verified), and again after a 401. A wrong PIN asks again with "PIN
// incorrect"; a cancel sends nothing more. No PIN is left in localStorage or
// sessionStorage, and the PIN the browser used to keep there is purged on load.
//
// Driven through the real serverApi and a stubbed fetch.

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { PinDialogProvider } from './PinDialog'
import * as api from '../api'

const PIN = '418273'
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const pinRequired = () => json(401, { error: 'human_gate_key_required' })

let fetchSpy

beforeEach(() => {
  fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

// A stand-in for any Admin control: each click is one PIN-protected change.
function Change() {
  const [result, setResult] = useState('')
  const click = () =>
    api.setProjectEnabled(7, true).then(
      () => setResult('saved'),
      (err) => setResult(err.message),
    )
  return (
    <>
      <button onClick={click}>Change</button>
      <output>{result}</output>
    </>
  )
}

function renderChange() {
  return render(
    <PinDialogProvider>
      <Change />
    </PinDialogProvider>,
  )
}

const dialog = () => screen.queryByRole('dialog', { name: 'Enter your gate PIN' })
const sent = (n) => fetchSpy.mock.calls[n][1].headers

function noPinStored() {
  for (const storage of [localStorage, sessionStorage]) {
    expect(storage.getItem('horizon_gate_pin')).toBeNull()
    expect(Object.values({ ...storage })).not.toContain(PIN)
  }
}

test('the dialog opens for the first change, not the second, and again after a 401', async () => {
  renderChange()

  // First change: the session is not verified, so the server asks for the PIN.
  fetchSpy.mockResolvedValueOnce(pinRequired()).mockResolvedValueOnce(json(200, { ok: true }))
  fireEvent.click(screen.getByText('Change'))
  await waitFor(() => expect(dialog()).not.toBeNull())
  expect(sent(0)).toEqual({ 'Content-Type': 'application/json', 'x-horizon-csrf': '1' })
  const input = screen.getByLabelText('Gate PIN')
  expect(input.getAttribute('type')).toBe('password')
  expect(input.getAttribute('autocomplete')).toBe('one-time-code')
  fireEvent.change(input, { target: { value: PIN } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await screen.findByText('saved')
  expect(dialog()).toBeNull()
  expect(sent(1)['x-human-key']).toBe(PIN)
  expect(api.pinSessionLikelyVerified()).toBe(true)

  // Second change: the session is verified, so no dialog and no PIN is sent.
  fetchSpy.mockResolvedValueOnce(json(200, { ok: true }))
  fireEvent.click(screen.getByText('Change'))
  await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3))
  await act(async () => {})
  expect(dialog()).toBeNull()
  expect(sent(2)['x-human-key']).toBeUndefined()
  expect(sent(2)['x-horizon-csrf']).toBe('1')

  // The verification ended (12 hours, Lock elsewhere): a 401 opens it again.
  fetchSpy.mockResolvedValueOnce(pinRequired()).mockResolvedValueOnce(json(200, { ok: true }))
  fireEvent.click(screen.getByText('Change'))
  await waitFor(() => expect(dialog()).not.toBeNull())
  expect(api.pinSessionLikelyVerified()).toBe(false)
  expect(screen.getByLabelText('Gate PIN').value).toBe('')
  fireEvent.change(screen.getByLabelText('Gate PIN'), { target: { value: PIN } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(5))
  await waitFor(() => expect(dialog()).toBeNull())

  noPinStored()
})

test('a wrong PIN asks again with "PIN incorrect"; a cancel sends nothing more', async () => {
  renderChange()
  fetchSpy.mockResolvedValueOnce(pinRequired()).mockResolvedValueOnce(pinRequired())
  fireEvent.click(screen.getByText('Change'))
  await waitFor(() => expect(dialog()).not.toBeNull())
  expect(screen.queryByText('PIN incorrect — try again.')).toBeNull()
  fireEvent.change(screen.getByLabelText('Gate PIN'), { target: { value: '000000' } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

  await screen.findByText('PIN incorrect — try again.')
  expect(screen.getByLabelText('Gate PIN').value).toBe('')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await screen.findByText('pin_needed')
  expect(dialog()).toBeNull()
  expect(fetchSpy).toHaveBeenCalledTimes(2)
  noPinStored()
})

test('Escape cancels the dialog', async () => {
  renderChange()
  fetchSpy.mockResolvedValueOnce(pinRequired())
  fireEvent.click(screen.getByText('Change'))
  await waitFor(() => expect(dialog()).not.toBeNull())
  fireEvent.keyDown(window, { key: 'Escape' })
  await screen.findByText('pin_needed')
  expect(fetchSpy).toHaveBeenCalledTimes(1)
})

test('the PIN an older build kept in localStorage or sessionStorage is purged on load', async () => {
  localStorage.setItem('horizon_gate_pin', PIN)
  sessionStorage.setItem('horizon_gate_pin', PIN)
  vi.resetModules()
  await import('../api/serverApi')
  noPinStored()
})

test('mock mode has the same PIN exports, through the api index', async () => {
  vi.stubEnv('VITE_MOCK', '1')
  vi.resetModules()
  const mock = await import('../api/index.js')
  expect(mock.pinSessionLikelyVerified()).toBe(true)
  await expect(mock.lockPinSession()).resolves.toEqual({ ok: true })
  expect(mock.getPinVerifiedUntil()).toBeNull()
  expect(() => mock.setPinRequester(() => null)).not.toThrow()
})
