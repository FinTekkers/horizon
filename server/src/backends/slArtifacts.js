// HO-878: the sl backend's Artifact port (backends/artifact.js) — a file
// store under the Horizon data dir, because an sl repo has no GitHub refs to
// hold a publish. forRepo(repo).artifacts hands these methods out for an sl
// repo; they pass test/contracts/artifact.contract.mjs like GitHub's do.
//
// Layout, one folder per project, under the data dir (HORIZON_DB's folder):
//
//   artifacts/p<projectId>/items/<item-key>             symlink → <item-key>.gen/<commit>
//   artifacts/p<projectId>/items/<item-key>.gen/<commit>/
//       e2e/__screenshots__/<name>.png, manifest.json, results.json
//       meta.json                                       { itemId, repo, savedAt, files }
//   artifacts/p<projectId>/baseline                     symlink → baseline.gen/<commit>
//   artifacts/p<projectId>/baseline.gen/<commit>/
//       e2e/__screenshots__/<name>.png, meta.json      { files, promotedAt, itemId }
//
// A file's `sha` is the sha256 of its bytes; a generation's `commit` is the
// sha256 of its sorted "path sha" lines, so it fits the approve route's 64
// characters and changes whenever any file does. Generations are per item, so
// two items with the same content never share a folder.
//
// Guardrails, all enforced here:
//   - Paths: an item id, project id, file name or link target that would leave
//     its folder is refused with an ArtifactStoreError — never cleaned up into
//     something else — and refused before anything is written. Every folder is
//     checked to be a plain directory (no symlink) under the data dir's real
//     path, and every link must name its own generation exactly.
//   - Atomic: a generation is written into a .tmp-* folder (every file
//     fsynced), renamed into place, and only then does a symlink rename swap
//     it in. A crash leaves at most an unlinked .tmp-* or generation folder,
//     which no read follows. The old generation is deleted last, so a read in
//     flight can still lose it: that read fails and the route logs a warning.
//   - Baseline files are hardlinks shared between baseline generations (and,
//     at promotion, with the item's publish). They are never written in place:
//     every change writes a new generation.
//   - Prune and promote take one project's lock and touch only that project's
//     folder. Prune deletes only items/<key> and items/<key>.gen, never a
//     baseline file, and never follows a symlink.
//
// The server is one process (horizon-server), so an in-process lock per
// project is enough to serialise writes. This module never imports github.js,
// spawns a process or makes a network call.
//
// HO-892: a bundle that carries the repo's diff settings gets GitHub's pixel
// diff — the same farm/capture/pixelDiff.mjs that farm/capture/diff.mjs runs,
// with the same threshold and ratioTolerance — against the sl baseline. A
// changed shot's diff PNG is one more file of the generation, at
// e2e/__screenshots__/diff/<name>.png, so it lands through the same .tmp-*
// folder and rename as every other file and is read through genFile.

import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

import { diffPngs } from '../../../farm/capture/pixelDiff.mjs'
import { db } from '../db.js'
import { msOf, sqlTime } from '../sqlTime.js'
import { SCREENSHOT_DIR } from './artifact.js'
import { artifactPruneReason, isScreenshotResults, promotionEntries } from './artifactRules.js'

// The same window as GitHub's ARTIFACTS_PRUNE_MS, with its own cursor.
export const SL_ARTIFACTS_PRUNE_MS = 24 * 60 * 60 * 1000
const PRUNE_KEY = 'sl-artifacts-prune'

// One farm bundle: at most this many files, this big each and in total. The
// /complete body limit (app.js) leaves room for these after base64.
export const BUNDLE_LIMITS = Object.freeze({ maxFiles: 200, maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 24 * 1024 * 1024 })

const ROOT_NAME = 'artifacts'
const META = 'meta.json'
const RESULTS_PATH = `${SCREENSHOT_DIR}/results.json`
const COMMIT_RE = /^[0-9a-f]{64}$/
// An item id as Horizon issues them (HO-878, T-SS-1); lowercased for its key.
const ITEM_ID_RE = /^[A-Za-z][A-Za-z0-9]{0,31}(?:-[A-Za-z0-9]{1,32}){1,3}$/
const ITEM_KEY_RE = /^[a-z][a-z0-9]{0,31}(?:-[a-z0-9]{1,32}){1,3}$/
// A file name: no leading dot (so never `.`, `..` or a hidden file), no slash.
const NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/
const MANIFEST_NAME = 'manifest.json'
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/
// The paths a generation may hold: shots, diffs, manifest and results.
const CONTENT_PATH_RE = new RegExp(`^${SCREENSHOT_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:diff/)?[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$`)
const TOP_SHOT_RE = new RegExp(`^${SCREENSHOT_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([A-Za-z0-9_-][A-Za-z0-9._-]{0,99})\\.png$`)

export class ArtifactStoreError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'ArtifactStoreError'
    this.code = code
  }
}

// ---- keys and paths ----

// The store key of an item id, or ArtifactStoreError('bad_item_key').
export function itemKey(itemId) {
  if (typeof itemId !== 'string' || !ITEM_ID_RE.test(itemId)) {
    throw new ArtifactStoreError('bad_item_key', `refused item id ${JSON.stringify(String(itemId)).slice(0, 80)}`)
  }
  return itemId.toLowerCase()
}

// The folder name of a project id, or ArtifactStoreError('bad_project_key').
export function projectKey(projectId) {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new ArtifactStoreError('bad_project_key', `refused project id ${JSON.stringify(projectId) ?? String(projectId)}`)
  }
  return `p${projectId}`
}

// The same lookup as backends/index.js's selectRepoBackend, plus the project.
const selectRepoProject = db.prepare(`
  SELECT r.project_id, r.backend FROM project_repo r JOIN project p ON p.id = r.project_id
  WHERE r.repo = ? COLLATE NOCASE ORDER BY p.isolation = 'tenant' DESC LIMIT 1
`)

// The project of an sl repo, or null for any other repo.
function slProjectOf(repo) {
  if (typeof repo !== 'string') return null
  const row = selectRepoProject.get(repo)
  return row?.backend === 'sl' ? row.project_id : null
}

// The Horizon data dir: the folder HORIZON_DB lives in (db.js creates it).
const dataDir = () => realpathSync(path.dirname(path.resolve(db.name)))

const lstatOrNull = (p) => {
  try {
    return lstatSync(p)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function assertPlainDir(p, st = lstatSync(p)) {
  if (st.isSymbolicLink() || !st.isDirectory()) throw new ArtifactStoreError('bad_path', `${p} is not a plain directory`)
  return p
}

// `parent`/`name` as a plain directory (made when `create`), or null. `parent`
// is already a real path, so a plain child is one too.
function subdir(parent, name, create) {
  const target = path.join(parent, name)
  let st = lstatOrNull(target)
  if (!st && create) {
    try {
      mkdirSync(target)
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    st = lstatSync(target)
  }
  return st ? assertPlainDir(target, st) : null
}

// The project's folders: { project, items }, made when `create`; null (or
// items null) when they do not exist yet.
function storeDirs(projectId, create) {
  const key = projectKey(projectId)
  const root = subdir(dataDir(), ROOT_NAME, create)
  const project = root && subdir(root, key, create)
  if (!project) return null
  return { project, items: subdir(project, 'items', create) }
}

// A file inside a generation, by its relative path: every folder on the way
// is plain and the file is a regular file, never a symlink.
function genFile(genDir, rel) {
  if (rel !== META && !CONTENT_PATH_RE.test(rel)) throw new ArtifactStoreError('bad_path', `refused path ${rel}`)
  const parts = rel.split('/')
  let at = genDir
  for (const part of parts.slice(0, -1)) assertPlainDir((at = path.join(at, part)))
  const file = path.join(at, parts.at(-1))
  const st = lstatSync(file)
  if (!st.isFile()) throw new ArtifactStoreError('bad_path', `${rel} is not a regular file`)
  return file
}

// A generation that `dir/name` (a symlink) points at: { commit, dir }, or null
// with no link. The link must name `<expect>/<commit>` exactly.
function linkedGeneration(dir, name, expect) {
  const link = path.join(dir, name)
  const st = lstatOrNull(link)
  if (!st) return null
  if (!st.isSymbolicLink()) throw new ArtifactStoreError('bad_link', `${name} is not a store link`)
  const parts = readlinkSync(link).split('/')
  if (parts.length !== 2 || parts[0] !== expect || !COMMIT_RE.test(parts[1])) {
    throw new ArtifactStoreError('bad_link', `${name} points outside its generations`)
  }
  assertPlainDir(path.join(dir, expect))
  return { commit: parts[1], dir: assertPlainDir(path.join(dir, expect, parts[1])) }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

// A generation's commit: the sha256 of its sorted "path sha" lines.
function commitOf(files) {
  const lines = [...files].map(([rel, { sha }]) => `${rel} ${sha}\n`).sort()
  return sha256(lines.join(''))
}

// meta.json's files as a Map path → { sha, size }, checked.
function filesOf(genDir) {
  const meta = JSON.parse(readFileSync(genFile(genDir, META), 'utf8'))
  const files = new Map()
  for (const [rel, entry] of Object.entries(meta?.files ?? {})) {
    if (!CONTENT_PATH_RE.test(rel) || !COMMIT_RE.test(entry?.sha ?? '') || !Number.isSafeInteger(entry?.size)) {
      throw new ArtifactStoreError('bad_path', `meta.json lists a bad entry ${rel}`)
    }
    files.set(rel, { sha: entry.sha, size: entry.size })
  }
  return { meta, files }
}

// The bytes of `rel` in a generation, checked against the sha it was listed with.
function readContent(genDir, rel, sha) {
  const bytes = readFileSync(genFile(genDir, rel))
  if (sha256(bytes) !== sha) throw new Error(`stored ${rel} does not match its sha`)
  return bytes
}

// The current baseline: { commit, dir, files } or null when there is none.
function currentBaseline(dirs) {
  const gen = dirs && linkedGeneration(dirs.project, 'baseline', 'baseline.gen')
  return gen && { ...gen, files: filesOf(gen.dir).files }
}

// A baseline generation by commit, current or kept, or null when it is gone.
function baselineAt(dirs, commit) {
  const genParent = path.join(dirs.project, 'baseline.gen')
  const dir = path.join(genParent, commit)
  if (!lstatOrNull(dir)) return null
  assertPlainDir(genParent)
  assertPlainDir(dir)
  return { commit, dir, files: filesOf(dir).files }
}

// ---- durable writes ----

let faultForTest = null
// Test seam: `fn(point)` runs at 'save' and 'promote' once a generation's first
// file is down; a throw stands in for a crash mid-write.
export function setArtifactFaultForTest(fn) {
  faultForTest = fn ?? null
}

function fsyncPath(p) {
  const fd = openSync(p, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function writeDurable(file, bytes) {
  const fd = openSync(file, 'wx', 0o644)
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

// A hardlink of a stored file; a copy where the filesystem refuses links.
function linkOrCopy(source, target) {
  try {
    linkSync(source, target)
  } catch (err) {
    if (!['EXDEV', 'EPERM', 'EMLINK', 'ENOTSUP'].includes(err.code)) throw err
    copyFileSync(source, target)
    fsyncPath(target)
  }
}

// Writes one generation under `genParent`: `files` maps path → { sha, size }
// plus `bytes` (new content) or `source` (a stored file to hardlink). Returns
// its commit. An identical generation already in place is reused as it is.
function writeGeneration(genParent, files, meta, point) {
  const commit = commitOf(files)
  const final = path.join(genParent, commit)
  if (lstatOrNull(final)) {
    assertPlainDir(final)
    return commit
  }
  const tmp = path.join(genParent, `.tmp-${randomBytes(8).toString('hex')}`)
  mkdirSync(tmp)
  try {
    const dirs = new Set([tmp])
    let written = 0
    for (const [rel, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      const target = path.join(tmp, rel)
      for (let dir = path.dirname(target); !dirs.has(dir); dir = path.dirname(dir)) dirs.add(dir)
      mkdirSync(path.dirname(target), { recursive: true })
      if (file.bytes) writeDurable(target, file.bytes)
      else linkOrCopy(file.source, target)
      if (++written === 1) faultForTest?.(point)
    }
    const listing = Object.fromEntries([...files].map(([rel, { sha, size }]) => [rel, { sha, size }]))
    writeDurable(path.join(tmp, META), JSON.stringify({ ...meta, files: listing }, null, 2))
    for (const dir of dirs) fsyncPath(dir)
    renameSync(tmp, final)
    fsyncPath(genParent)
    return commit
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true })
    throw err
  }
}

// Points `dir/name` at `target` with one rename, so a reader sees the old
// generation or the new one, never neither.
function swapLink(dir, name, target) {
  const tmp = path.join(dir, `.tmp-link-${randomBytes(8).toString('hex')}`)
  symlinkSync(target, tmp)
  try {
    renameSync(tmp, path.join(dir, name))
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
  fsyncPath(dir)
}

// Deletes every entry of `genParent` but `keep`. rmSync never follows a link.
function dropGenerations(genParent, keep) {
  for (const name of readdirSync(genParent)) {
    if (!keep.has(name)) rmSync(path.join(genParent, name), { recursive: true, force: true })
  }
}

// Deletes one item's store: its link (only the link, wherever it points) and
// its generations.
function removeItemStore(items, key) {
  const link = path.join(items, key)
  const st = lstatOrNull(link)
  if (st?.isDirectory()) rmSync(link, { recursive: true, force: true })
  else if (st) unlinkSync(link)
  rmSync(path.join(items, `${key}.gen`), { recursive: true, force: true })
}

// ---- per-project lock ----

const locks = new Map()

function withLock(projectId, fn) {
  const prev = locks.get(projectId) ?? Promise.resolve()
  const run = prev.then(fn)
  const tail = run.then(
    () => {},
    () => {},
  )
  locks.set(projectId, tail)
  tail.then(() => {
    if (locks.get(projectId) === tail) locks.delete(projectId)
  })
  return run
}

// ---- reads ----

// The item's key, project and folders; null when its repo is not an sl repo
// or nothing is stored for the project yet.
function itemStore(item) {
  const key = itemKey(item?.id)
  const projectId = slProjectOf(item?.repo)
  if (projectId == null) return null
  const dirs = storeDirs(projectId, false)
  return dirs?.items ? { key, projectId, dirs } : null
}

function readSnapshot({ key, dirs }) {
  const gen = linkedGeneration(dirs.items, key, `${key}.gen`)
  if (!gen) return null
  const { files } = filesOf(gen.dir)
  const resultsEntry = files.get(RESULTS_PATH)
  if (!resultsEntry) return null
  let results
  try {
    results = JSON.parse(readContent(gen.dir, RESULTS_PATH, resultsEntry.sha).toString('utf8'))
  } catch (err) {
    if (err instanceof SyntaxError) return null
    throw err
  }
  if (!isScreenshotResults(results)) return null
  const baseline = COMMIT_RE.test(results.baseline || '') ? baselineAt(dirs, results.baseline) : null
  return { commit: gen.commit, results, files, baselineFiles: baseline?.files ?? null, dir: gen.dir, baseline }
}

// Retries once when a generation vanished under the read (a save or promote
// swapped it out); a second miss rejects.
function readStable(store) {
  try {
    return readSnapshot(store)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    return readSnapshot(store)
  }
}

export async function readArtifacts(item) {
  const store = itemStore(item)
  const snapshot = store && readStable(store)
  if (!snapshot) return null
  const { commit, results, files, baselineFiles } = snapshot
  return { commit, results, files, baselineFiles }
}

// The bytes of a file readArtifacts listed — in the item's publish, the
// baseline it was compared with, or the current baseline — by its sha256.
export async function readArtifactBlob(item, sha) {
  if (typeof sha !== 'string' || !COMMIT_RE.test(sha)) throw new ArtifactStoreError('bad_sha', 'a blob is named by its sha256')
  const store = itemStore(item)
  if (!store) throw new Error(`no stored artifacts for ${item?.id}`)
  const snapshot = readStable(store)
  const places = [snapshot && { dir: snapshot.dir, files: snapshot.files }, snapshot?.baseline, currentBaseline(store.dirs)]
  for (const place of places) {
    if (!place) continue
    for (const [rel, entry] of place.files) {
      if (entry.sha === sha) return readContent(place.dir, rel, sha)
    }
  }
  throw new Error(`no stored artifact ${sha} for ${item.id}`)
}

export async function listArtifacts(repo) {
  const projectId = slProjectOf(repo)
  const dirs = projectId == null ? null : storeDirs(projectId, false)
  if (!dirs?.items) return []
  const ids = []
  for (const name of readdirSync(dirs.items)) {
    if (!ITEM_KEY_RE.test(name)) continue
    try {
      const gen = linkedGeneration(dirs.items, name, `${name}.gen`)
      const { meta } = filesOf(gen.dir)
      if (String(meta.repo).toLowerCase() === repo.toLowerCase()) ids.push(name)
    } catch {
      // not a readable store of this repo: not listed
    }
  }
  return ids.sort()
}

// ---- writes ----

// Stores a publish ({ results, files }: files maps a path under SCREENSHOT_DIR
// to its bytes) as the item's current one, replacing the last. The harness of
// the shared contract seeds through this; the farm's bundle reaches it through
// saveScreenshotBundle. Resolves { commit, shots }.
export async function publishArtifacts(item, { results, files } = {}) {
  const key = itemKey(item?.id)
  const projectId = slProjectOf(item?.repo)
  if (projectId == null) throw new ArtifactStoreError('not_sl_project', `${item?.repo} is not an sl repo`)
  projectKey(projectId)
  if (!isScreenshotResults(results)) throw new ArtifactStoreError('bad_results', 'results.json has the wrong shape')
  if (!(files instanceof Map)) throw new ArtifactStoreError('bad_bundle', 'files must be a Map')
  const content = new Map()
  for (const [rel, bytes] of files) {
    if (typeof rel !== 'string' || !CONTENT_PATH_RE.test(rel) || rel === RESULTS_PATH) throw new ArtifactStoreError('bad_name', `refused path ${rel}`)
    if (!Buffer.isBuffer(bytes)) throw new ArtifactStoreError('bad_bundle', `${rel} is not bytes`)
    content.set(rel, { bytes, sha: sha256(bytes), size: bytes.length })
  }
  const resultsBytes = Buffer.from(`${JSON.stringify(results, null, 2)}\n`)
  content.set(RESULTS_PATH, { bytes: resultsBytes, sha: sha256(resultsBytes), size: resultsBytes.length })
  return withLock(projectId, () => {
    const dirs = storeDirs(projectId, true)
    const genParent = subdir(dirs.items, `${key}.gen`, true)
    const meta = { itemId: item.id, repo: item.repo, savedAt: new Date().toISOString() }
    const commit = writeGeneration(genParent, content, meta, 'save')
    swapLink(dirs.items, key, `${key}.gen/${commit}`)
    dropGenerations(genParent, new Set([commit]))
    return { commit, shots: results.shots.length }
  })
}

// HO-892: the bundle's pixel-diff settings ({ threshold, ratioTolerance },
// each a number in [0, 1], as farm/screenshots_config.py validates them), or
// null when it carries none — a farm from before HO-892 — and shots are then
// compared by sha256 only, as HO-878 did.
function diffSettingsOf(bundle) {
  const diff = Object.hasOwn(bundle, 'diff') ? bundle.diff : null
  if (diff == null) return null
  const unit = (key) => Object.hasOwn(diff, key) && typeof diff[key] === 'number' && diff[key] >= 0 && diff[key] <= 1
  if (typeof diff !== 'object' || Array.isArray(diff) || !unit('threshold') || !unit('ratioTolerance')) {
    throw new ArtifactStoreError('bad_bundle', 'diff settings are a threshold and a ratioTolerance in [0, 1]')
  }
  return { threshold: diff.threshold, ratioTolerance: diff.ratioTolerance }
}

// The farm's bundle checked and decoded: { shots: Map name → PNG bytes,
// manifest, diff }. Sizes are checked from the base64 length, before any decode.
function decodeBundle(bundle) {
  const list = bundle?.files
  if (!Array.isArray(list) || list.length === 0) throw new ArtifactStoreError('bad_bundle', 'a bundle lists its files')
  if (list.length > BUNDLE_LIMITS.maxFiles) throw new ArtifactStoreError('too_large', `${list.length} files`)
  let total = 0
  for (const entry of list) {
    if (typeof entry?.data !== 'string') throw new ArtifactStoreError('bad_bundle', 'every file carries base64 data')
    const bytes = Math.floor(entry.data.length / 4) * 3
    total += bytes
    if (bytes > BUNDLE_LIMITS.maxFileBytes || total > BUNDLE_LIMITS.maxTotalBytes) throw new ArtifactStoreError('too_large', 'over the bundle cap')
  }
  const shots = new Map()
  let manifest = null
  for (const { path: name, data } of list) {
    const shot = typeof name === 'string' && NAME_RE.test(name) && name.endsWith('.png') && name.length > 4
    if (!shot && name !== MANIFEST_NAME) throw new ArtifactStoreError('bad_name', `refused file name ${JSON.stringify(String(name)).slice(0, 120)}`)
    if (data.length % 4 !== 0 || !BASE64_RE.test(data)) throw new ArtifactStoreError('bad_bundle', `${name} is not base64`)
    const bytes = Buffer.from(data, 'base64')
    if (shot) {
      const stem = name.slice(0, -4)
      if (shots.has(stem)) throw new ArtifactStoreError('bad_name', `${name} is listed twice`)
      if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) throw new ArtifactStoreError('bad_png', `${name} is not a PNG`)
      shots.set(stem, bytes)
    } else {
      if (manifest) throw new ArtifactStoreError('bad_name', `${name} is listed twice`)
      manifest = bytes
    }
  }
  if (shots.size === 0) throw new ArtifactStoreError('bad_bundle', 'no screenshots')
  return { shots, manifest, diff: diffSettingsOf(bundle) }
}

// HO-892: one changed shot's row, pixel-diffed against its baseline file the
// way farm/capture/diff.mjs diffs a GitHub pair: `same` within the tolerance
// (no diff PNG), else `changed` with its diff PNG put in `diffs`. A pair that
// fails (a corrupt PNG, a baseline file gone) is `changed` with `error` set and
// no PNG, and the other shots still diff. Each pair waits a turn of the event
// loop first, so a big bundle never holds the server for more than one pair.
// `base` is the baseline file's { rel, sha } in generation `baseDir`.
async function pixelRow(name, current, baseDir, base, settings, diffs) {
  await new Promise((resolve) => setImmediate(resolve))
  try {
    const { status, diffRatio, png } = diffPngs(current, readContent(baseDir, base.rel, base.sha), settings, { pixelmatch, PNG })
    if (png) diffs.set(name, png)
    return { name, status, diffRatio, diff: png ? `${SCREENSHOT_DIR}/diff/${name}.png` : null, error: null }
  } catch (err) {
    return { name, status: 'changed', diffRatio: null, diff: null, error: String(err?.message || err).slice(0, 300) }
  }
}

// { results, diffs }: results.json for `shots` (name → bytes) against the
// current baseline — same, changed, new or removed — and the diff PNG of each
// changed shot (name → bytes). Equal sha256s are `same` without a diff. With
// no `settings` there is no pixel diff (HO-878): a changed shot has diffRatio
// null and no diff image. With them, results.json also records them, as
// GitHub's does.
async function resultsAgainst(shots, baseline, settings) {
  const base = new Map()
  for (const [rel, entry] of baseline?.files ?? []) {
    const m = TOP_SHOT_RE.exec(rel)
    if (m) base.set(m[1], { rel, sha: entry.sha })
  }
  const rows = []
  const diffs = new Map()
  for (const name of [...new Set([...shots.keys(), ...base.keys()])].sort()) {
    let status = 'changed'
    if (!base.has(name)) status = 'new'
    else if (!shots.has(name)) status = 'removed'
    else if (sha256(shots.get(name)) === base.get(name).sha) status = 'same'
    else if (settings) {
      rows.push(await pixelRow(name, shots.get(name), baseline.dir, base.get(name), settings, diffs))
      continue
    }
    rows.push({ name, status, diffRatio: status === 'same' ? 0 : null, diff: null, error: null })
  }
  const head = { version: 1, baseline: baseline?.commit ?? null }
  const results = settings ? { ...head, ...settings, shots: rows } : { ...head, shots: rows }
  return { results, diffs }
}

// HO-878: the farm's screenshot bundle for an sl item —
// { files: [{ path: '<name>.png' | 'manifest.json', data: <base64> }],
//   diff?: { threshold, ratioTolerance } (HO-892) }, as
// farm/step_agent.py's screenshot_bundle builds it — stored as the item's
// publish. Rejects with an ArtifactStoreError (nothing written) on a bad one.
export async function saveScreenshotBundle(item, bundle) {
  itemKey(item?.id)
  const projectId = slProjectOf(item?.repo)
  if (projectId == null) throw new ArtifactStoreError('not_sl_project', `${item?.repo} is not an sl repo`)
  projectKey(projectId)
  const { shots, manifest, diff } = decodeBundle(bundle)
  const { results, diffs } = await resultsAgainst(shots, currentBaseline(storeDirs(projectId, false)), diff)
  const files = new Map([...shots].map(([name, bytes]) => [`${SCREENSHOT_DIR}/${name}.png`, bytes]))
  if (manifest) files.set(`${SCREENSHOT_DIR}/${MANIFEST_NAME}`, manifest)
  for (const [name, png] of diffs) files.set(`${SCREENSHOT_DIR}/diff/${name}.png`, png)
  return publishArtifacts(item, { results, files })
}

// Best-effort: never rejects.
export async function removeArtifacts(item) {
  try {
    const store = itemStore(item)
    if (store) await withLock(store.projectId, () => removeItemStore(store.dirs.items, store.key))
  } catch {
    // best-effort, as on GitHub
  }
}

// The baseline commits an item's current publish was compared with.
function referencedBaselines(items) {
  const out = new Set()
  for (const name of readdirSync(items)) {
    if (!ITEM_KEY_RE.test(name)) continue
    try {
      const snapshot = readSnapshot({ key: name, dirs: { items, project: path.dirname(items) } })
      if (snapshot?.baseline) out.add(snapshot.baseline.commit)
    } catch {
      // unreadable: it references nothing
    }
  }
  return out
}

// HZ-510's promotion, on files: the approved shots of the item's publish go
// into a new baseline generation built from hardlinks of the current one, the
// baseline link swaps to it, and the item's publish is removed. Generations no
// current publish was compared with are dropped (the current and previous one
// always stay).
export async function promoteArtifacts(item, approvals, { log } = {}) {
  const store = itemStore(item)
  if (!store) return null
  return withLock(store.projectId, () => {
    const { key, dirs } = store
    const snapshot = readSnapshot(store)
    if (!snapshot) {
      if (lstatOrNull(path.join(dirs.items, key))) throw new Error('the publish has no readable results.json')
      return null
    }
    if (!approvals) throw new Error('approvals unavailable')
    const head = currentBaseline(dirs)
    const { entries, skipped } = promotionEntries(snapshot.results, approvals, snapshot.files, head?.files ?? null)
    for (const name of skipped) log?.warn(`${item.id}: approved screenshot ${name} has no image in its publish — its baseline is kept`)
    if (entries.length === 0) {
      removeItemStore(dirs.items, key)
      return { promoted: 0, seeded: false }
    }
    const next = new Map()
    for (const [rel, entry] of head?.files ?? []) next.set(rel, { ...entry, source: genFile(head.dir, rel) })
    for (const { path: rel, sha } of entries) {
      if (sha === null) next.delete(rel)
      else next.set(rel, { sha, size: snapshot.files.get(rel).size, source: genFile(snapshot.dir, rel) })
    }
    const genParent = subdir(dirs.project, 'baseline.gen', true)
    const commit = writeGeneration(genParent, next, { itemId: item.id, promotedAt: new Date().toISOString() }, 'promote')
    swapLink(dirs.project, 'baseline', `baseline.gen/${commit}`)
    removeItemStore(dirs.items, key)
    dropGenerations(genParent, new Set([commit, ...(head ? [head.commit] : []), ...referencedBaselines(dirs.items)]))
    log?.info(`${item.id}: promoted ${entries.length} approved screenshot(s) into the sl baseline`)
    return { promoted: entries.length, seeded: !head }
  })
}

// HZ-513's daily sweep, on files: at most once per SL_ARTIFACTS_PRUNE_MS
// (remembered in sync_cursor, so a restart does not re-run it), drops the
// publishes whose items no longer need them — closed, merged, abandoned or
// unknown — in every project with an sl repo. An open item's publish is kept.
// Only items/<key> and items/<key>.gen are ever deleted.
const getCursor = db.prepare('SELECT last_synced_at FROM sync_cursor WHERE key = ?')
const setCursor = db.prepare(`
  INSERT INTO sync_cursor (key, etag, last_synced_at) VALUES (?, NULL, ?)
  ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, last_synced_at = excluded.last_synced_at
`)
const slProjects = db.prepare("SELECT DISTINCT project_id FROM project_repo WHERE backend = 'sl' ORDER BY project_id")
const projectItem = db.prepare(`
  SELECT id, kind, cursor, abandoned_at, merged_at FROM work_item
  WHERE lower(id) = ? AND lower(repo) IN (SELECT lower(repo) FROM project_repo WHERE project_id = ? AND backend = 'sl')
`)

export async function pruneArtifacts({ log, now = Date.now() } = {}) {
  const last = getCursor.get(PRUNE_KEY)?.last_synced_at
  // HO-893: a sweep inside the window deletes nothing and says so.
  if (last && now - msOf(last) < SL_ARTIFACTS_PRUNE_MS) {
    log?.info(`sl artifacts prune: skipped — the last sweep ran at ${last}`)
    return null
  }
  const projects = slProjects.all().map((row) => row.project_id)
  if (projects.length === 0) return null
  setCursor.run(PRUNE_KEY, sqlTime(now))
  let deleted = 0
  for (const projectId of projects) {
    await withLock(projectId, () => {
      const items = storeDirs(projectId, false)?.items
      if (!items) return
      const keys = new Set()
      for (const name of readdirSync(items)) {
        const key = name.endsWith('.gen') ? name.slice(0, -'.gen'.length) : name
        if (ITEM_KEY_RE.test(key)) keys.add(key)
      }
      for (const key of keys) {
        const why = artifactPruneReason(projectItem.get(key, projectId))
        if (!why) continue
        try {
          removeItemStore(items, key)
          deleted++
          log?.info(`deleted the sl artifacts of ${key} in project ${projectId} (${why})`)
        } catch (err) {
          log?.warn(`could not delete the sl artifacts of ${key} in project ${projectId}: ${err.message}`)
        }
      }
    }).catch((err) => log?.warn(`could not prune sl artifacts in project ${projectId}: ${err.message}`))
  }
  log?.info(`sl artifacts prune: ${deleted} store(s) deleted`)
  return { deleted }
}
