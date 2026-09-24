// Dark-mode state (HZ-25): a single source of truth persisted to
// localStorage and applied via a `data-theme` attribute on <html>, so the
// CSS custom-property swap in index.css cascades without a React re-render.
// Mirrors the subscribe/get shape used by ui/src/api so components can do
// useSyncExternalStore(theme.subscribe, theme.getTheme).

const STORAGE_KEY = 'horizon_theme'
const listeners = new Set()

// localStorage throws in some private-browsing modes — the toggle still
// works for the current page load, it just won't persist across reloads.
function readStorage() {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStorage(value) {
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // ignore — see readStorage
  }
}

export function getTheme() {
  return readStorage() === 'dark' ? 'dark' : 'light'
}

export function setTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light'
  writeStorage(next)
  document.documentElement.dataset.theme = next
  listeners.forEach((fn) => fn())
}

export function toggleTheme() {
  setTheme(getTheme() === 'dark' ? 'light' : 'dark')
}

export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
