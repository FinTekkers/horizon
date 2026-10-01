// HZ-224: the only JS reader of the phone breakpoint. jsdom has no
// window.matchMedia, so each test installs (and removes) its own stub.

import { expect, test, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'

import { MOBILE_QUERY, useMediaQuery } from './useMediaQuery'

afterEach(() => {
  cleanup()
  delete window.matchMedia
})

function stubMatchMedia(initial) {
  const listeners = new Set()
  const mql = {
    matches: initial,
    addEventListener: (type, fn) => type === 'change' && listeners.add(fn),
    removeEventListener: (type, fn) => type === 'change' && listeners.delete(fn),
  }
  window.matchMedia = (query) => {
    mql.media = query
    return mql
  }
  return {
    mql,
    listeners,
    set(matches) {
      mql.matches = matches
      listeners.forEach((fn) => fn({ matches }))
    },
  }
}

test('is false when matchMedia is missing, so jsdom and old browsers get desktop', () => {
  expect(window.matchMedia).toBeUndefined()
  const { result } = renderHook(() => useMediaQuery(MOBILE_QUERY))
  expect(result.current).toBe(false)
})

test('is true on the first render when the query already matches', () => {
  const stub = stubMatchMedia(true)
  const { result } = renderHook(() => useMediaQuery(MOBILE_QUERY))
  expect(result.current).toBe(true)
  expect(stub.mql.media).toBe('(max-width: 699px)')
})

test('flips when the media query fires a change event', () => {
  const stub = stubMatchMedia(false)
  const { result } = renderHook(() => useMediaQuery(MOBILE_QUERY))
  expect(result.current).toBe(false)
  act(() => stub.set(true))
  expect(result.current).toBe(true)
  act(() => stub.set(false))
  expect(result.current).toBe(false)
})

test('removes its change listener on unmount', () => {
  const stub = stubMatchMedia(false)
  const { unmount } = renderHook(() => useMediaQuery(MOBILE_QUERY))
  expect(stub.listeners.size).toBe(1)
  unmount()
  expect(stub.listeners.size).toBe(0)
})
