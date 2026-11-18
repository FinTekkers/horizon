// HO-890: the daily artifact sweep, for every backend, through its Artifact
// port (backends/artifact.js): forKind(backend).artifacts.pruneArtifacts. It
// replaces the two schedules that skipped the port — GitHub's inside
// startPolling and HO-878's sl one in server.js.
//
// Each adapter sweeps only the repos on its own backend and keeps its own
// sync_cursor record of when it last ran (GitHub `artifacts-prune`, sl
// `sl-artifacts-prune`), so this tick only has to call each one. Best-effort:
// one backend's prune that throws or rejects is logged and never stops
// another's, and a tick never rejects.

import { BACKENDS } from './names.js'
import { forKind } from './index.js'

// The same cadence each backend's own schedule had: once a day.
export const PRUNE_TICK_MS = 24 * 60 * 60 * 1000

// GitHub's warning keeps the text startPolling logged; sl's, the text server.js
// logged.
const failurePrefix = (backend) => (backend === 'github' ? 'artifacts prune failed' : `${backend} artifacts prune failed`)

// One sweep: every backend's prune, side by side. Resolves to
// { [backend]: result | { error } }, where result is the adapter's own
// ({ deleted } or null when it skipped).
export async function pruneTick(log) {
  const entries = await Promise.all(
    BACKENDS.map((backend) =>
      Promise.resolve()
        .then(() => forKind(backend).artifacts.pruneArtifacts({ log }))
        .then(
          (result) => [backend, result ?? null],
          (err) => {
            const message = err?.message ?? String(err)
            log?.warn(`${failurePrefix(backend)}: ${message}`)
            return [backend, { error: message }]
          },
        ),
    ),
  )
  return Object.fromEntries(entries)
}

// Boot: one sweep now, then one every PRUNE_TICK_MS. The timer never keeps the
// process alive. Returns the timer.
export function startArtifactPrune(log) {
  pruneTick(log)
  const timer = setInterval(() => pruneTick(log), PRUNE_TICK_MS)
  timer.unref?.()
  return timer
}
