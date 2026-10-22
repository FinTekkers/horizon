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

// HZ-512: with no stored choice, follow the browser's prefers-color-scheme
// (also what makes a screenshot shot's colorScheme: 'dark' render dark). A
// stored choice always wins. The pre-paint script in index.html mirrors this.
export function getTheme() {
  const stored = readStorage()
  if (stored === 'dark' || stored === 'light') return stored
  return prefersDark() ? 'dark' : 'light'
}

function prefersDark() {
  try {
    return Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  } catch {
    return false
  }
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
