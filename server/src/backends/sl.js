// HO-870: the sl backend's adapters. The groups and method names are built
// from githubAdapters, so the two shapes cannot drift apart. A method with no
// sl implementation yet throws `backend_not_implemented: sl`: an sl repo's
// call never falls back to GitHub.
//
// HO-878: the artifacts group's six Artifact port methods (backends/artifact.js)
// are real — the file store in backends/slArtifacts.js. Its GitHub-shaped
// helpers still throw. slScreenshotPublisher stores the screenshot bundle an
// sl item's implement result carries (the sl farm pushes no ref).
//
// HO-875: the tracker group's twelve Tracker port methods (backends/tracker.js)
// are real too — Tasks through farmd, in backends/slTracker.js — on a server
// with a farm (FARM_URL). farmd is the sl Tracker's only implementation, so
// with no farm configured every sl tracker method stays the HO-870
// backend_not_implemented placeholder and nothing falls back to GitHub. The
// six GitHub-shaped tracker helpers (issue bodies and labels) always throw;
// their call sites run only for an item with a GitHub issue.
//
// HO-877: vcs.land on a server with a farm is backends/sl/vcs.js. Only the
// registry may import backends/sl/ (test/backend-boundary.test.mjs), so
// backends/index.js puts it in place of this placeholder.

import { githubAdapters } from './github.js'
import { ARTIFACT_METHODS } from './artifact.js'
import { TRACKER_PORT_METHODS } from './tracker.js'
import { FARM_URL } from '../config.js'
import * as slArtifacts from './slArtifacts.js'
import * as slTracker from './slTracker.js'

function notImplemented(group, name) {
  return function slNotImplemented() {
    throw new Error(`backend_not_implemented: sl (${group}.${name})`)
  }
}

// group → [the port methods that are real, the module that implements them]
const REAL = Object.freeze({ artifacts: [ARTIFACT_METHODS, slArtifacts], tracker: [FARM_URL ? TRACKER_PORT_METHODS : [], slTracker] })
const realMethod = (group, name) => (Object.hasOwn(REAL, group) && REAL[group][0].includes(name) ? REAL[group][1][name] : null)

export const slAdapters = Object.freeze(
  Object.fromEntries(
    Object.entries(githubAdapters).map(([group, methods]) => [
      group,
      Object.freeze(
        Object.fromEntries(
          Object.keys(methods).map((name) => [name, realMethod(group, name) ?? notImplemented(group, name)]),
        ),
      ),
    ]),
  ),
)

export const slScreenshotPublisher = slArtifacts.saveScreenshotBundle
