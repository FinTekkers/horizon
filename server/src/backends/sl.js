// HO-870: the sl backend's adapters. The groups and method names are built
// from githubAdapters, so the two shapes cannot drift apart. A method with no
// sl implementation yet throws `backend_not_implemented: sl`: an sl repo's
// call never falls back to GitHub.
//
// HO-878: the artifacts group's six Artifact port methods (backends/artifact.js)
// are real — the file store in backends/slArtifacts.js. Its GitHub-shaped
// helpers still throw. slScreenshotPublisher stores the screenshot bundle an
// sl item's implement result carries (the sl farm pushes no ref).

import { githubAdapters } from './github.js'
import { ARTIFACT_METHODS } from './artifact.js'
import * as slArtifacts from './slArtifacts.js'

function notImplemented(group, name) {
  return function slNotImplemented() {
    throw new Error(`backend_not_implemented: sl (${group}.${name})`)
  }
}

const implemented = (group, name) => group === 'artifacts' && ARTIFACT_METHODS.includes(name)

export const slAdapters = Object.freeze(
  Object.fromEntries(
    Object.entries(githubAdapters).map(([group, methods]) => [
      group,
      Object.freeze(
        Object.fromEntries(
          Object.keys(methods).map((name) => [name, implemented(group, name) ? slArtifacts[name] : notImplemented(group, name)]),
        ),
      ),
    ]),
  ),
)

export const slScreenshotPublisher = slArtifacts.saveScreenshotBundle
