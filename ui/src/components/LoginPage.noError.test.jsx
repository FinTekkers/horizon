// HZ-454: the login page with no ?error= param renders with no error banner —
// moved here from e2e/tests/10-login-error.spec.js, which keeps the ?error=
// redirect journey through the real server.

import { afterEach, beforeEach, expect, test } from 'vitest'
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

test('with no ?error= param, the login page renders with no error banner', () => {
  const { container } = render(<LoginPage onLoggedIn={() => {}} />)
  expect(container.querySelector('.login__submit')).toBeTruthy()
  expect(container.querySelector('.gh-error')).toBeNull()
})
