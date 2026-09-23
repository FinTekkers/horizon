// HZ-37: a failed /api/auth/google/* callback redirects here with
// ?error=<code> instead of rendering raw JSON — this page must turn that
// into a readable message and then scrub the param from the URL.

import { expect, test, afterEach, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

import LoginPage from './LoginPage'

const ORIGINAL_URL = window.location.href

beforeEach(() => {
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', ORIGINAL_URL)
})

const noop = () => {}

test('with no ?error= param, no error banner is shown', () => {
  render(<LoginPage onLoggedIn={noop} />)
  expect(document.querySelector('.gh-error')).toBeNull()
})

test('?error=google_link_blocked renders a readable message, not the raw code', () => {
  window.history.replaceState({}, '', '/?error=google_link_blocked')
  render(<LoginPage onLoggedIn={noop} />)
  const banner = document.querySelector('.gh-error')
  expect(banner).toBeTruthy()
  expect(banner.textContent).not.toMatch(/google_link_blocked/)
  expect(banner.textContent.toLowerCase()).toContain('verified')
})

test.each([
  ['google_sso_not_configured'],
  ['bad_state'],
  ['google_auth_failed'],
  ['account_link_failed'],
  ['google_login_not_allowed'],
])('?error=%s renders some readable message', (code) => {
  window.history.replaceState({}, '', `/?error=${code}`)
  render(<LoginPage onLoggedIn={noop} />)
  const banner = document.querySelector('.gh-error')
  expect(banner).toBeTruthy()
  expect(banner.textContent.length).toBeGreaterThan(0)
})

test('an unrecognized ?error= code still shows a generic message instead of nothing', () => {
  window.history.replaceState({}, '', '/?error=something_new_and_unmapped')
  render(<LoginPage onLoggedIn={noop} />)
  const banner = document.querySelector('.gh-error')
  expect(banner).toBeTruthy()
})

test('the ?error= param is stripped from the URL after mount', () => {
  window.history.replaceState({}, '', '/?error=bad_state')
  render(<LoginPage onLoggedIn={noop} />)
  expect(window.location.search).toBe('')
})

test('stripping ?error= preserves other query params', () => {
  window.history.replaceState({}, '', '/?foo=bar&error=bad_state')
  render(<LoginPage onLoggedIn={noop} />)
  expect(window.location.search).toBe('?foo=bar')
})
