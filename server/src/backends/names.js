// HO-870: the backends a Horizon repo can run on, and the default. A leaf
// module with no imports, so db.js and store.js can read the value set without
// loading the adapter registry (backends/index.js), which pulls in github.js
// and, through it, store.js itself. store.js and db.js import only this file.
//
// `github` is the default: every repo and item from before HO-870 is GitHub,
// and a connect that names no backend stays GitHub. There is no `internal`.

export const DEFAULT_BACKEND = 'github'
export const BACKENDS = Object.freeze([DEFAULT_BACKEND, 'sl'])

export function isBackend(value) {
  return typeof value === 'string' && BACKENDS.includes(value)
}
