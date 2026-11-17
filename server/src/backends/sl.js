// HO-870: the sl backend's adapters — placeholders until the sl tracker and
// diff flow exist. The groups and method names are built from githubAdapters,
// so the two shapes cannot drift apart. Every method throws
// `backend_not_implemented: sl`: an sl repo's call never falls back to GitHub.

import { githubAdapters } from './github.js'

function notImplemented(group, name) {
  return function slNotImplemented() {
    throw new Error(`backend_not_implemented: sl (${group}.${name})`)
  }
}

export const slAdapters = Object.freeze(
  Object.fromEntries(
    Object.entries(githubAdapters).map(([group, methods]) => [
      group,
      Object.freeze(Object.fromEntries(Object.keys(methods).map((name) => [name, notImplemented(group, name)]))),
    ]),
  ),
)
