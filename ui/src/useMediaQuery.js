import { useCallback, useSyncExternalStore } from 'react'

// HZ-224: the phone breakpoint, as JS sees it. The CSS copy is the
// `@media (max-width: 699px)` block at the end of index.css — CSS owns the
// layout (it compacts the top bar); JS reads the same query only to decide
// whether to mount the bottom nav. Keep the two values identical
// (ui/src/mobileCss.test.js checks it).
export const MOBILE_QUERY = '(max-width: 699px)'

// No matchMedia (jsdom, very old browsers) means desktop: nothing extra is
// mounted, which is exactly today's behaviour.
function mediaQueryList(query) {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null
}

// Same useSyncExternalStore shape as theme.js — the first render reads the
// query synchronously, so a phone never paints a frame without the nav.
export function useMediaQuery(query) {
  const subscribe = useCallback(
    (onChange) => {
      const mql = mediaQueryList(query)
      if (!mql) return () => {}
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    [query],
  )
  const getSnapshot = () => mediaQueryList(query)?.matches ?? false
  return useSyncExternalStore(subscribe, getSnapshot)
}
