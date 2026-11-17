// HO-873: the Artifact port. Every backend's `artifacts` adapter group —
// forRepo(repo).artifacts — carries these methods, so code that reads, lists,
// removes, prunes or promotes an item's published screenshots never names a
// backend, a storage location or a client. The shared contract that every
// adapter must pass is test/contracts/artifact.contract.mjs.
//
// A publish (the farm pushes it after an implement run, not the server) holds
// the item's shots, their diffs and results.json under SCREENSHOT_DIR. The
// server only reads a publish, removes it, sweeps stale ones and promotes
// approved shots into the repo's baseline.
//
// Every method takes an item shaped { id, repo }:
//
//   readArtifacts(item) → Promise<{ commit, results, files, baselineFiles } | null>
//       The item's latest publish, or null when there is none to show.
//       `commit` is an opaque id of the publish. `files` is a Map of
//       path → { sha, size }, where `sha` is an opaque content id that
//       readArtifactBlob takes. `baselineFiles` is the same kind of Map for
//       the baseline the publish was compared with, or null.
//   readArtifactBlob(item, sha) → Promise<Buffer>
//       The bytes of one file `readArtifacts` listed.
//   listArtifacts(repo) → Promise<string[]>
//       The ids of the items in `repo` that have a publish. An id may come
//       back in another case than the item's; compare case-insensitively.
//   removeArtifacts(item) → Promise<void>
//       Drops the item's publish. Best-effort: never rejects.
//   pruneArtifacts({ log, now }) → Promise<{ deleted } | null>
//       Removes the publishes whose items no longer need them. It is a
//       rate-limited sweep: null means it skipped because it ran too recently.
//       Each adapter sweeps only the repos on its own backend and keeps its
//       own record of when it last ran.
//   promoteArtifacts(item, approvals, { log }) → Promise<{ promoted, seeded } | null>
//       Copies the approved shots (a Set of shot names) of the item's publish
//       into the repo's baseline, then removes the publish. null when the item
//       has no publish. Rejects when `approvals` is null and there is a publish.
//
// A leaf module: it imports nothing, so it can hold no client or backend type.

export const ARTIFACT_METHODS = Object.freeze([
  'readArtifacts',
  'readArtifactBlob',
  'listArtifacts',
  'removeArtifacts',
  'pruneArtifacts',
  'promoteArtifacts',
])

// Where a publish puts the shots (<name>.png), their diffs (diff/<name>.png)
// and results.json — the same layout on every backend.
export const SCREENSHOT_DIR = 'e2e/__screenshots__'
