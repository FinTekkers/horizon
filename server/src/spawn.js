// HZ-379: an item files other items for itself and waits for them. Today the
// one caller is a Task whose Assess step finds code is needed: Horizon files
// a normal change item in the Task's repo, the Task depends on it, and the
// Task's Run plan starts only once that change's merge is live. The engine
// takes a LIST of items from one parent, so a later "plan mode" can file
// several at once through the same calls.
//
// Which step spawns, what reply field triggers it and what kind it files are
// read from domain/steps.json (spawnsOn, spawnKind, awaitsSpawnedCode) —
// nothing here names a step or compares an item kind.
//
// Three moments, three calls, so the caller can do every await first and then
// add the dependency edges synchronously (orchestrator.completeFarmRun):
//   - spawnItems: files the items (GitHub issue, or a local item in demo
//     mode). Never adds an edge.
//   - linkSpawned: adds parent -> child dependency edges with
//     store.addDependency, the existing blocking path.
//   - spawnedCodeLive: whether every closed spawned dependency's merge is
//     live, and the commit to run on.
//
// item_spawn's UNIQUE(parent_id, request_key, seq) is the idempotency key: a
// retried step or a re-delivered completion asks with the same request key
// and files nothing new. A 'filing' row left by a restart is taken over, and
// the issue-body marker keeps that from filing a second issue.

import { db } from './db.js'
import * as store from './store.js'
import * as github from './github.js'
import { UI_URL } from './config.js'
import { redact } from './caretakerRules.js'
import { HOST_PATH } from './split.js'
import { resolveTarget } from './deploy.js'
import { isClosed, isItemKind } from '../../domain/js/lifecycle.js'
import { criteriaLines, fieldByName } from '../../domain/js/fields.js'

// ---- the step flags ----

// { field, kind } for a step that files items when its reply carries
// `field`, or null.
export function spawnRuleOf(step) {
  if (!step || typeof step.spawnsOn !== 'string' || !step.spawnsOn) return null
  return { field: step.spawnsOn, kind: step.spawnKind }
}

// Whether this step waits for its item's spawned code to be live.
export function awaitsSpawnedCode(step) {
  return step?.awaitsSpawnedCode === true
}

// ---- one item to file ----

// The spec's text fields and the work-item limits each is held to.
const SPEC_FIELDS = ['title', 'outcome', 'metric', 'guardrails'].map((name) => fieldByName(name))
const SPEC_REQUIRED = ['outcome', 'metric']

// The child's text may land in a GitHub issue: secrets and host paths go, as
// split.js does for an upstream issue.
const clean = (text) => redact(text, { oneLine: false }).replace(HOST_PATH, '[host path removed]').trim()

// { spec } for a usable item to file, or { error } naming what is wrong. An
// over-limit field is an error, not a silent cut: the child must carry what
// the parent asked for.
export function validateSpawnSpec(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'expected an object' }
  const spec = {}
  for (const { name: key, maxLength, maxLines } of SPEC_FIELDS) {
    if (!Object.hasOwn(raw, key) || raw[key] == null) {
      spec[key] = ''
      continue
    }
    if (typeof raw[key] !== 'string') return { error: `${key} must be a string` }
    const value = clean(raw[key])
    if (value.length > maxLength) return { error: `${key} is ${value.length} characters, over the ${maxLength} limit` }
    const lines = criteriaLines(value).length
    if (maxLines !== undefined && lines > maxLines) return { error: `${key} has ${lines} lines, over the ${maxLines} limit` }
    spec[key] = value
  }
  spec.title = spec.title.replace(/\s+/g, ' ')
  const missing = SPEC_REQUIRED.filter((key) => !spec[key])
  if (missing.length > 0) return { error: `missing ${missing.join(', ')}` }
  return { spec }
}

// ---- request keys ----

const selectRows = db.prepare('SELECT * FROM item_spawn WHERE parent_id = ? ORDER BY request_key, seq')
const selectKeyRows = db.prepare('SELECT * FROM item_spawn WHERE parent_id = ? AND request_key = ? ORDER BY seq')
const selectRow = db.prepare('SELECT * FROM item_spawn WHERE id = ?')

// A request is settled once every item it asked for was filed and has closed
// or been abandoned.
function settled(rows) {
  return rows.every((r) => {
    if (r.status !== 'filed' || !r.child_id) return false
    const child = store.getItem(r.child_id)
    return !child || isClosed(child) || !!child.abandoned_at
  })
}

// The key a step's run files under: `step:<index>:<gen>`, gen counting this
// step's earlier requests that have settled. A retry while the child is open
// gets the same key (nothing new is filed); a later run of the step, after
// its child shipped, gets a new one.
export function requestKeyFor(parentId, stepIndex) {
  const prefix = `step:${stepIndex}:`
  const byKey = new Map()
  for (const row of selectRows.all(parentId)) {
    if (!row.request_key.startsWith(prefix)) continue
    if (!byKey.has(row.request_key)) byKey.set(row.request_key, [])
    byKey.get(row.request_key).push(row)
  }
  let gen = 0
  for (const rows of byKey.values()) if (settled(rows)) gen++
  return `${prefix}${gen}`
}

// ---- filing ----

export const spawnMarker = (parentId, requestKey, seq) =>
  `<!-- horizon-spawned-by: ${parentId} key=${requestKey} seq=${seq} -->`

// The child issue's body after its Outcome / Success metric / Guardrails: a
// back-link and the marker. Its own heading, so parseIssueBody keeps both out
// of the child's guardrails.
function spawnBodySuffix(parent, requestKey, seq) {
  const issueRef = parent.repo && parent.issue != null ? ` · \`${parent.repo}#${parent.issue}\`` : ''
  return [
    '## Spawned by',
    `[${parent.id}](${UI_URL}/${parent.id.toLowerCase()})${issueRef} — that item waits for this one to close.`,
    '',
    spawnMarker(parent.id, requestKey, seq),
  ].join('\n')
}

// SQLite's 'YYYY-MM-DD HH:MM:SS' (UTC) less an hour of clock-skew slack, as ISO.
function sinceIso(createdAt) {
  const ms = Date.parse(`${String(createdAt).replace(' ', 'T')}Z`)
  return new Date((Number.isNaN(ms) ? Date.now() : ms) - 60 * 60 * 1000).toISOString()
}

const insertRow = db.prepare(
  `INSERT OR IGNORE INTO item_spawn (parent_id, request_key, seq, kind, payload_json, target_repo, created_by)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
)
const claimRow = db.prepare(
  "UPDATE item_spawn SET status = 'filing', error = NULL, updated_at = datetime('now') WHERE id = ? AND status IN ('filing','failed')",
)
const finish = db.prepare(
  "UPDATE item_spawn SET status = ?, error = ?, child_id = COALESCE(?, child_id), updated_at = datetime('now') WHERE id = ? AND status = 'filing'",
)
const setTargetIssue = db.prepare("UPDATE item_spawn SET target_issue = ?, updated_at = datetime('now') WHERE id = ?")

// Rows a 'filing' call in THIS process holds. A 'filing' row not in here was
// left by a restart, and the next call may take it over.
const inflight = new Set()

async function fileOne(parent, row, spec) {
  const title = spec.title || `Code for ${parent.id}`
  if (!row.target_repo) {
    // Demo mode: a local item, written in the same transaction as the row
    // that records it, so a restart can never leave one without the other.
    return db.transaction(() => {
      const childId = store.createLocalItem({
        title,
        outcome: spec.outcome,
        metric: spec.metric,
        guardrails: spec.guardrails,
        priority: parent.priority,
        kind: row.kind,
      })
      if (typeof childId !== 'string') throw new Error(`could not create the item (${childId?.error || 'unknown error'})`)
      finish.run('filed', null, childId, row.id)
      return childId
    })()
  }
  let ghIssue = await github.findSplitIssue(row.target_repo, spawnMarker(parent.id, row.request_key, row.seq), sinceIso(row.created_at))
  if (!ghIssue) {
    ghIssue = await github.createIssue(row.target_repo, {
      title,
      outcome: spec.outcome,
      metric: spec.metric,
      guardrails: spec.guardrails,
      priority: parent.priority,
      kind: row.kind,
      bodySuffix: spawnBodySuffix(parent, row.request_key, row.seq),
    })
  }
  setTargetIssue.run(ghIssue.number, row.id)
  // The webhook may have synced it already; either way the item is looked up
  // by repo and issue, never built from the prefix by hand.
  store.upsertFromGithub(ghIssue, row.target_repo)
  const child = store.findItemByIssue(row.target_repo, ghIssue.number)
  if (!child) throw new Error(`${row.target_repo}#${ghIssue.number} did not sync in as an item`)
  finish.run('filed', null, child.id, row.id)
  return child.id
}

// Files every spec in `specs` for `parent`, in the parent's repo, under one
// request key. A spec already filed under that key is not filed again. Stops
// at the first failure: the rows filed before it stay filed, so a retry files
// only what is left. { ok, children } (the child ids, in spec order) or
// { error, status }.
export async function spawnItems(parent, specs, { requestKey, kind, actor = 'Horizon' }) {
  if (!parent?.id || !Array.isArray(specs) || specs.length === 0) return { error: 'nothing to file', status: 400 }
  if (typeof requestKey !== 'string' || !requestKey) return { error: 'a request key is required', status: 400 }
  if (!isItemKind(kind)) return { error: `unknown item kind "${kind}"`, status: 400 }
  const children = []
  for (const [seq, spec] of specs.entries()) {
    insertRow.run(parent.id, requestKey, seq, kind, JSON.stringify(spec), parent.repo || null, actor)
    let row = selectKeyRows.all(parent.id, requestKey).find((r) => r.seq === seq)
    if (row.status === 'filed') {
      children.push(row.child_id)
      continue
    }
    if (inflight.has(row.id)) return { error: `filing for ${parent.id} is already in progress`, status: 409 }
    if (claimRow.run(row.id).changes === 0) return { error: `filing for ${parent.id} is already in progress`, status: 409 }
    inflight.add(row.id)
    row = selectRow.get(row.id)
    try {
      // The row's own payload, so a retry files what was first asked for.
      const childId = await fileOne(parent, row, JSON.parse(row.payload_json))
      children.push(childId)
      store.addEvent(childId, {
        who: 'Horizon',
        text: `filed for ${parent.id} (${parent.title}) — that item waits for this one to close`,
        color: '#0E6E74',
        initials: 'HZ',
      })
      store.addEvent(parent.id, {
        who: 'Horizon',
        text: `filed ${childId}${row.target_repo ? ` (\`${row.target_repo}\`)` : ''} — this item waits for it to close`,
        color: '#0E6E74',
        initials: 'HZ',
      })
    } catch (err) {
      const message = redact(err.message)
      finish.run('failed', message, null, row.id)
      store.addEvent(parent.id, {
        who: 'Horizon',
        text: `could not file the ${kind} item${row.target_repo ? ` on ${row.target_repo}` : ''}: ${message}`,
        color: '#9C333E',
        initials: 'HZ',
      })
      return { error: `filing failed: ${message}`, status: 502 }
    } finally {
      inflight.delete(row.id)
    }
  }
  store.notifyChange()
  return { ok: true, children }
}

// Makes the parent depend on every item filed under `requestKey`. No awaits,
// so a caller can run it in the same tick as the step that asked. An edge
// that already exists counts as added. { ok, added } or { error }.
export function linkSpawned(parentId, requestKey) {
  const added = []
  for (const row of selectKeyRows.all(parentId, requestKey)) {
    if (row.status !== 'filed' || !row.child_id) return { error: `${parentId}'s request ${requestKey} is not fully filed` }
    const dep = store.addDependency(parentId, row.child_id, 'Horizon')
    if (dep.error) return { error: dep.message || `could not add the dependency on ${row.child_id} (${dep.error})` }
    added.push(row.child_id)
  }
  return { ok: true, added }
}

// Whether `parentId` has any filed child.
export function hasSpawned(parentId) {
  return selectRows.all(parentId).some((r) => r.status === 'filed' && r.child_id)
}

// ---- is the shipped code live ----

const defaultGit = {
  getPrMergeSha: (item) => github.getPrMergeSha(item),
  isAncestor: (repo, base, head) => github.isAncestor(repo, base, head),
  getBranchSha: (repo, branch) => github.getBranchSha(repo, branch),
  resolveTarget: (repo) => resolveTarget(repo),
}
let git = defaultGit

// Test seam: replaces any of the four lookups above; null restores them all.
export function setSpawnGitForTest(overrides) {
  git = overrides ? { ...defaultGit, ...overrides } : defaultGit
}

const selectLiveBatch = db.prepare(
  'SELECT commit_sha FROM deploy_batch WHERE target = ? AND live_at IS NOT NULL AND commit_sha IS NOT NULL ORDER BY live_at DESC, id DESC LIMIT 1',
)

const short = (sha) => String(sha).slice(0, 7)

// The commit the repo's deployed checkout is at: the latest live deploy
// batch for its target, or — for a repo with no deploy target — the default
// branch's head. { sha } or { reason }.
async function deployedHead(repo) {
  const target = git.resolveTarget(repo)
  if (!target) return { sha: await git.getBranchSha(repo, 'main') }
  const live = selectLiveBatch.get(target.key)
  return live ? { sha: live.commit_sha } : { reason: `nothing is live on ${target.key} yet` }
}

// { ready: true, sha } once every spawned child that is closed and still a
// dependency has its merge at or behind its repo's deployed HEAD; sha is that
// HEAD for the parent's own repo (null when the parent has no repo). An
// abandoned child whose edge was removed holds nothing. A child with no PR
// shipped no code, so it holds nothing either. { ready: false, reason }
// otherwise; a GitHub error is a reason too, never a throw.
export async function spawnedCodeLive(item) {
  const linked = new Set(store.blockersOf(item.id).map((b) => b.id))
  const heads = new Map()
  const headOf = async (repo) => {
    if (!heads.has(repo)) heads.set(repo, await deployedHead(repo))
    return heads.get(repo)
  }
  try {
    for (const row of selectRows.all(item.id)) {
      if (row.status !== 'filed' || !row.child_id || !linked.has(row.child_id)) continue
      const child = store.getItem(row.child_id)
      if (!child || !isClosed(child)) return { ready: false, reason: `${row.child_id} is still open` }
      if (!child.repo || child.pr == null) continue
      const mergeSha = store.deployBatchFactsFor(child.id)?.mergeSha || (await git.getPrMergeSha(child))
      const head = await headOf(child.repo)
      if (!head.sha) return { ready: false, reason: `merge not deployed: ${short(mergeSha)} (${child.id}) — ${head.reason}` }
      if (mergeSha !== head.sha && !(await git.isAncestor(child.repo, mergeSha, head.sha))) {
        return {
          ready: false,
          reason: `merge not deployed: ${short(mergeSha)} (${child.id}) is not in the deployed ${child.repo} at ${short(head.sha)} yet`,
        }
      }
    }
    if (!item.repo) return { ready: true, sha: null }
    return { ready: true, sha: (await headOf(item.repo)).sha || null }
  } catch (err) {
    return { ready: false, reason: `could not check the shipped code: ${redact(err.message)}` }
  }
}
