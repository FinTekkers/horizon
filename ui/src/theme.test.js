// HZ-512: with no stored choice the theme follows prefers-color-scheme; a
// stored choice always wins. jsdom has no window.matchMedia, so each test
// installs (and removes) its own stub.

import { expect, test, afterEach } from 'vitest'

import { getTheme, toggleTheme } from './theme'

afterEach(() => {
  localStorage.clear()
  delete window.matchMedia
  delete document.documentElement.dataset.theme
})

function stubPrefersDark(dark) {
  window.matchMedia = (query) => ({ media: query, matches: query === '(prefers-color-scheme: dark)' && dark })
}

test('no stored theme follows the browser: dark when it prefers dark, else light', () => {
  stubPrefersDark(true)
  expect(getTheme()).toBe('dark')
  stubPrefersDark(false)
  expect(getTheme()).toBe('light')
})

test('no stored theme and no matchMedia (jsdom, old browsers) is light', () => {
  expect(window.matchMedia).toBeUndefined()
  expect(getTheme()).toBe('light')
})

test('a stored theme overrides the browser preference', () => {
  stubPrefersDark(true)
  localStorage.setItem('horizon_theme', 'light')
  expect(getTheme()).toBe('light')

  stubPrefersDark(false)
  localStorage.setItem('horizon_theme', 'dark')
  expect(getTheme()).toBe('dark')
})

test('toggling from the browser default stores the opposite choice', () => {
  stubPrefersDark(true)
  toggleTheme()
  expect(localStorage.getItem('horizon_theme')).toBe('light')
  expect(document.documentElement.dataset.theme).toBe('light')
  expect(getTheme()).toBe('light')
})
