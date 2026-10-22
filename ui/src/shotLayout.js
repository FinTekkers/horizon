// HZ-548: the screenshot panel's per-browser layout — 'side' (the three images
// side by side, the default) or 'stacked' (one image per row, full width).
// The same localStorage + subscribe shape as boardNarrowing.js, under its own
// key. A missing, bad or unknown stored value reads as 'side'.

const STORAGE_KEY = 'horizon.shotLayout'
const LAYOUTS = ['side', 'stacked']
const listeners = new Set()

function readStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return LAYOUTS.includes(raw) ? raw : 'side'
  } catch {
    return 'side'
  }
}

let cached = readStorage()

export function getShotLayout() {
  return cached
}

export function setShotLayout(layout) {
  cached = LAYOUTS.includes(layout) ? layout : 'side'
  try {
    localStorage.setItem(STORAGE_KEY, cached)
  } catch {
    // ignore — private browsing; the choice lasts for this page only
  }
  listeners.forEach((fn) => fn())
}

export function subscribeShotLayout(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Test-only: a re-read of storage, as a page reload does.
export function _reloadForTests() {
  cached = readStorage()
}
