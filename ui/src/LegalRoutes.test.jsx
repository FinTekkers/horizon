// The Privacy Policy and Terms of Service are public: /privacy and /terms
// must render for a signed-out visitor without ever hitting the login gate,
// while every other route still requires a session.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'

vi.mock('./api', () => ({
  getCurrentUser: vi.fn(async () => null),
  googleLoginUrl: () => '/api/auth/google/start',
  login: vi.fn(),
}))

import * as api from './api'
import App from './App'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.history.replaceState({}, '', '/')
})

function visit(path) {
  window.history.replaceState({}, '', path)
  return render(<App />)
}

test.each([
  ['/privacy', 'Privacy Policy'],
  ['/terms', 'Terms of Service'],
  ['/PRIVACY/', 'Privacy Policy'],
])('%s renders the public legal page for a signed-out visitor', (path, title) => {
  const { container } = visit(path)
  expect(container.querySelector('h1.legal__title').textContent).toBe(title)
  expect(container.querySelector('.login__submit')).toBeNull()
  // Public means public: the page must not wait on, or even ask for, a session.
  expect(api.getCurrentUser).not.toHaveBeenCalled()
})

test('legal pages name Shoreward LLC, New York law and the contact address', () => {
  const privacy = visit('/privacy').container
  expect(privacy.textContent).toContain('Shoreward LLC')
  expect(privacy.querySelector('a[href="mailto:help@fintekkers.org"]')).not.toBeNull()
  cleanup()
  const terms = visit('/terms').container
  expect(terms.textContent).toContain('laws of the State of New York')
  expect(terms.textContent).toContain('Shoreward LLC')
  expect(terms.querySelector('a[href="mailto:help@fintekkers.org"]')).not.toBeNull()
})

test('each legal page links to both documents', () => {
  const { container } = visit('/terms')
  const hrefs = [...container.querySelectorAll('.legal__footer a')].map((a) => a.getAttribute('href'))
  expect(hrefs).toEqual(['/privacy', '/terms'])
})

test('the login page links to both legal documents', async () => {
  const { container } = visit('/')
  await waitFor(() => expect(container.querySelector('.login__submit')).not.toBeNull())
  const hrefs = [...container.querySelectorAll('.login__legal a')].map((a) => a.getAttribute('href'))
  expect(hrefs).toEqual(['/privacy', '/terms'])
})

test('an item deep link still requires a session', async () => {
  const { container } = visit('/hz-102')
  await waitFor(() => expect(container.querySelector('.login__submit')).not.toBeNull())
  expect(container.querySelector('.legal')).toBeNull()
  expect(api.getCurrentUser).toHaveBeenCalled()
})
