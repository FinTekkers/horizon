// GitHub issue sync — event-based via webhooks, with an ETag-conditional
// polling fallback for anything missed (and for setups without a public
// endpoint/tunnel). Both paths funnel into store.upsertFromGithub().
//
// Repo/token come from settings.js (UI-configurable, env fallback), so sync
// can be enabled at runtime without a restart.

import crypto from 'node:crypto'
import { db } from './db.js'
import * as store from './store.js'
import { getToken, getSetting, setSetting } from './settings.js'
import { POLL_INTERVAL_MS, UI_URL } from './config.js'
import { ACCEPT_GATE_INDEX, endIndex, itemKindOf } from '../../domain/js/lifecycle.js'
import { PRIORITY } from '../../domain/js/priorities.js'
import { PRIORITY_LABEL_RE, priorityLabelName } from './priorityLabels.js'
import { kindLabelName } from './kindLabels.js'
import { AUTOPILOT_OFF_LABEL } from './autopilotOffLabel.js'
import { spliceIssueBody } from './caretakerRulingRules.js'
import { msOf } from './sqlTime.js'

const itemLink = (item) => `[open in Horizon](${UI_URL}/${item.id.toLowerCase()})`

const getCursor = db.prepare('SELECT etag FROM sync_cursor WHERE key = ?')
const setCursor = db.prepare(`
  INSERT INTO sync_cursor (key, etag, last_synced_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, last_synced_at = excluded.last_synced_at
`)

// Last poll outcome per repo, surfaced to the UI via the SSE snapshot.
const lastByRepo = {}

export function getSyncState() {
  return {
    tokenConfigured: !!getToken(),
    repos: store.listRepos().map((r) => ({ ...r, last: lastByRepo[r.repo] || null })),
  }
}

export function ghHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'horizon-server',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

// Accepts "owner/name", a github.com URL, or an SSH remote; returns the
// canonical "owner/name" or null.
export function parseRepo(input) {
  let s = (input || '').trim()
  if (!s) return null
  s = s.replace(/^git@github\.com:/i, '')
  s = s.replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '')
  s = s.replace(/\.git$/i, '')
  s = s.replace(/^\/+|\/+$/g, '')
  const parts = s.split('/')
  if (parts.length !== 2) return null
  const [owner, name] = parts
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null
  return `${owner}/${name}`
}

// Used when saving a token from the Admin page.
export async function validateToken(token) {
  const res = await fetch('https://api.github.com/user', { headers: ghHeaders(token) })
  if (res.ok) return { ok: true, login: (await res.json()).login }
  return { ok: false, error: res.status === 401 ? 'GitHub rejected the token' : `GitHub returned ${res.status}` }
}

// Used when connecting a repo to a project. Returns GitHub's canonical
// full_name so case variants can't be connected twice, and (HZ-425) its
// default branch from the same response.
export async function validateRepo(repo, token) {
  const res = await fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders(token) })
  if (res.ok) {
    const body = await res.json()
    return { ok: true, fullName: body.full_name, defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : null }
  }
  const error =
    res.status === 404
      ? 'Repository not found — check the name, or the token lacks access to it'
      : res.status === 401
        ? 'GitHub rejected the token'
        : `GitHub returned ${res.status}`
  return { ok: false, status: res.status, error }
}

// ---- issue creation (the UI's "New work item" flow) ----
// Inverse of parseIssueBody in store.js.

export function composeIssueBody({ outcome, metric, guardrails }) {
  return [
    '## Outcome',
    outcome.trim(),
    '',
    '## Success metric',
    metric.trim(),
    '',
    '## Guardrails',
    guardrails?.trim() || '_Defaults apply (tests, linters, e2e must pass)._',
  ].join('\n')
}

// Hex, not theme tokens: these are persisted to GitHub, which has no idea what a
// CSS variable is. Colour is presentation, so it stays here rather than moving
// into domain/ (HZ-135 guardrail 5) — but the KEYS are PRIORITY's, not a second
// hand-typed copy of the vocabulary. Keying by named constant rather than by
// array position is deliberate: a reordered domain/priorities.json must not
// silently recolour every label. server/test/domain-priority-pins.test.mjs pins
// the resulting map to the exact hex values it had before HZ-135, and asserts
// every declared priority has one.
// Exported so the two tests can split the work without either becoming a
// tautology: server/test/priority-labels.test.mjs asserts the POST body carries
// THIS map's colour for each value (proving the path is wired), and
// domain-priority-pins.test.mjs asserts the map itself still equals the
// hand-typed hex it had before HZ-135 (proving no colour moved). Same split
// ui/src/domain/lifecycle.js's PRIORITY_COLORS already gets.
export const PRIORITY_LABEL_COLORS = {
  [PRIORITY.CRITICAL]: '9C333E',
  [PRIORITY.HIGH]: 'DFA200',
  [PRIORITY.MEDIUM]: '2E6CB2',
  [PRIORITY.LOW]: '8C8C8E',
}

async function ensurePriorityLabel(repo, token, priority) {
  const name = priorityLabelName(priority)
  // Creating an issue with a nonexistent label silently drops it, so create
  // the label first; 422 means it already exists.
  const res = await fetch(`https://api.github.com/repos/${repo}/labels`, {
    method: 'POST',
    headers: ghHeaders(token),
    body: JSON.stringify({ name, color: PRIORITY_LABEL_COLORS[priority] || '8C8C8E' }),
  })
  if (!res.ok && res.status !== 422) return null // label is nice-to-have; don't block creation
  return name
}

// HZ-382: the `task` label a Task's issue carries, so whichever of the webhook
// or the create route imports the issue first reads the same kind off it.
// Unlike the priority label this one is load-bearing — without it the issue
// imports as a change, and a kind is never changed after creation — so the
// caller treats null as a failure, not a nice-to-have.
async function ensureKindLabel(repo, token, kind) {
  const name = kindLabelName(kind)
  const res = await fetch(`https://api.github.com/repos/${repo}/labels`, {
    method: 'POST',
    headers: ghHeaders(token),
    body: JSON.stringify({ name, color: '5E4380' }),
  })
  if (!res.ok && res.status !== 422) return null // 422: the label already exists
  return name
}

// HZ-449: the lane label (`trivial`) a Plan files a draft with. Like the kind
// label it is load-bearing — it is what selects the lane when the issue
// imports (kindLabels.laneFromLabels) — so the caller treats null as a failure.
async function ensureLaneLabel(repo, token, lane) {
  const res = await fetch(`https://api.github.com/repos/${repo}/labels`, {
    method: 'POST',
    headers: ghHeaders(token),
    body: JSON.stringify({ name: lane, color: '0E6E74' }),
  })
  if (!res.ok && res.status !== 422) return null // 422: the label already exists
  return lane
}

// Mirror a Horizon-side priority change onto the issue's `priority: *` label
// so the next sync reads the same value back. Best-effort by design: the
// caller never blocks on it, but a swallowed failure here means a later issue
// edit can sync the stale label's priority back over the database.
//
// HZ-135: the pattern that used to be declared here was a byte-for-byte copy of
// store.js's, under a different name. Both now come from ./priorityLabels.js,
// which also owns the name format ensurePriorityLabel writes — so the label we
// create and the label we recognise as stale cannot drift apart.
export async function setPriorityLabel(item, priority) {
  const token = getToken()
  const name = await ensurePriorityLabel(item.repo, token, priority)
  if (!name) throw new Error('could not ensure the priority label exists')
  const current = await gh(`/repos/${item.repo}/issues/${item.issue}/labels`)
  if (current.ok) {
    for (const label of await current.json()) {
      if (PRIORITY_LABEL_RE.test(label?.name || '') && label.name !== name) {
        await gh(
          `/repos/${item.repo}/issues/${item.issue}/labels/${encodeURIComponent(label.name)}`,
          { method: 'DELETE' },
        ).catch(() => {})
      }
    }
  }
  const add = await gh(`/repos/${item.repo}/issues/${item.issue}/labels`, {
    method: 'POST',
    body: JSON.stringify({ labels: [name] }),
  })
  if (!add.ok) throw new Error(`GitHub returned ${add.status} adding the priority label`)
}

// HZ-544: adds (`off` true) or removes the `autopilot-off` label on the item's
// issue, then returns the issue as GitHub now has it, for the caller to sync
// through store.upsertFromGithub. Unlike the priority mirror this is not
// best-effort: the label is the only stored state, so any refusal throws and
// the caller changes nothing. A 422 creating the label means it already
// exists; a 404 removing it means it was already gone.
export async function setAutopilotOffLabel(item, off) {
  const issuePath = `/repos/${item.repo}/issues/${item.issue}`
  if (off) {
    await ensureAutopilotOffLabel(item.repo)
    const add = await gh(`${issuePath}/labels`, { method: 'POST', body: JSON.stringify({ labels: [AUTOPILOT_OFF_LABEL] }) })
    if (!add.ok) throw new Error(`GitHub returned ${add.status} adding the ${AUTOPILOT_OFF_LABEL} label`)
  } else {
    const remove = await gh(`${issuePath}/labels/${encodeURIComponent(AUTOPILOT_OFF_LABEL)}`, { method: 'DELETE' })
    if (!remove.ok && remove.status !== 404) throw new Error(`GitHub returned ${remove.status} removing the ${AUTOPILOT_OFF_LABEL} label`)
  }
  const issue = await gh(issuePath)
  if (!issue.ok) throw new Error(`GitHub returned ${issue.status} reading the issue back`)
  return issue.json()
}

// Creates the `autopilot-off` label on `repo`; a 422 means it already exists.
// Throws on any other refusal.
async function ensureAutopilotOffLabel(repo) {
  const create = await gh(`/repos/${repo}/labels`, {
    method: 'POST',
    body: JSON.stringify({ name: AUTOPILOT_OFF_LABEL, color: '2B2340' }),
  })
  if (!create.ok && create.status !== 422) throw new Error(`GitHub returned ${create.status} creating the ${AUTOPILOT_OFF_LABEL} label`)
}

// `bodySuffix` (HZ-313) is appended after the composed sections — the split's
// back-link and marker. The new-item route sends none.
// `kind` (HZ-382): a non-change kind adds its label, and refuses to create the
// issue at all if that label cannot be ensured — no orphan issue, and never a
// Task that silently imports as a change. `lane` (HZ-449) is the same: its
// label, or no issue. `autopilotOff` (HZ-642) adds the `autopilot-off` label
// the same way; it defaults to false, so every other caller is unchanged.
export async function createIssue(
  repo,
  { title, outcome, metric, guardrails, priority, kind = 'change', lane = null, bodySuffix = '', autopilotOff = false },
) {
  const token = getToken()
  let kindLabel = null
  if (kind !== 'change') {
    kindLabel = await ensureKindLabel(repo, token, kind)
    if (!kindLabel) throw new Error(`Could not create the "${kindLabelName(kind)}" label on ${repo}`)
  }
  const laneLabel = lane ? await ensureLaneLabel(repo, token, lane) : null
  if (lane && !laneLabel) throw new Error(`Could not create the "${lane}" label on ${repo}`)
  if (autopilotOff) await ensureAutopilotOffLabel(repo)
  const label = await ensurePriorityLabel(repo, token, priority)
  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: ghHeaders(token),
    body: JSON.stringify({
      title,
      body: composeIssueBody({ outcome, metric, guardrails }) + (bodySuffix ? `\n\n${bodySuffix}` : ''),
      labels: [label, kindLabel, laneLabel, autopilotOff ? AUTOPILOT_OFF_LABEL : null].filter(Boolean),
    }),
  })
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'GitHub rejected the token'
        : res.status === 403
          ? 'The token is not allowed to create issues — check it has Issues read/write (org tokens may await approval)'
          : res.status === 404
            ? 'Repository not found, or the token lacks access to it'
            : res.status === 410
              ? 'Issues are disabled on this repository'
              : `GitHub returned ${res.status}`
    const err = new Error(message)
    err.statusCode = res.status
    throw err
  }
  return res.json()
}

// ---- mock PR creation (the Execute step's output) ----
// The PR mechanics are real — branch, commit, pull request — only the code
// change is a placeholder work file. Real agents will push their actual
// changes to the same branch naming scheme; everything downstream (the
// "Accept the code" gate reviewing a PR) stays identical.

async function gh(path, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: { ...ghHeaders(getToken()), ...(options.headers || {}) },
  })
  return res
}

export async function createMockPr(item) {
  const repo = item.repo
  const branch = `horizon/${item.id.toLowerCase()}`

  const repoRes = await gh(`/repos/${repo}`)
  if (!repoRes.ok) throw new Error(`could not read the repository (${repoRes.status})`)
  const base = (await repoRes.json()).default_branch

  const refRes = await gh(`/repos/${repo}/git/ref/${encodeURIComponent(`heads/${base}`)}`)
  if (!refRes.ok) throw new Error(`could not read the ${base} branch (${refRes.status})`)
  const baseSha = (await refRes.json()).object.sha

  // Create the work branch; 422 means it already exists from a prior attempt.
  const createRef = await gh(`/repos/${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  })
  if (!createRef.ok && createRef.status !== 422) {
    throw new Error(`could not create branch ${branch} (${createRef.status} — check the token has Contents read/write)`)
  }

  // Commit the placeholder work file (include the existing file's sha on retries).
  const path = `.horizon/work/${item.id}.md`
  const existing = await gh(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`)
  const existingSha = existing.ok ? (await existing.json()).sha : undefined
  const fileBody = [
    `# ${item.id}: ${item.title}`,
    '',
    '## Outcome',
    item.desc || '_(none)_',
    '',
    '## Success metric',
    item.metric || '_(none)_',
    '',
    '## Guardrails',
    item.guardrails || '_(defaults apply)_',
    '',
    '---',
    '_Placeholder change committed by the Horizon mock Eng agent. A real agent will replace this with the actual implementation._',
  ].join('\n')
  const put = await gh(`/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `${item.id}: mock implementation (Horizon)`,
      content: Buffer.from(fileBody, 'utf8').toString('base64'),
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
    }),
  })
  if (!put.ok) throw new Error(`could not commit to ${branch} (${put.status} — check the token has Contents read/write)`)

  // Open the PR; on "already exists" reuse the open one.
  const prRes = await gh(`/repos/${repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: `${item.id}: ${item.title}`,
      head: branch,
      base,
      body: [
        item.issue != null ? `Relates to #${item.issue}.` : '',
        '',
        '## Success metric',
        item.metric || '_(none)_',
        '',
        '## Guardrails',
        item.guardrails || '_(defaults apply)_',
        '',
        `_Mock implementation opened by the Horizon Eng agent for the “Accept the code” gate · ${itemLink(item)}._`,
      ].join('\n'),
    }),
  })
  if (prRes.ok) return prRes.json()
  if (prRes.status === 422) {
    const open = await gh(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${repo.split('/')[0]}:${branch}`)}`)
    if (open.ok) {
      const prs = await open.json()
      if (prs.length > 0) return prs[0]
    }
  }
  throw new Error(`could not open the pull request (${prRes.status} — check the token has Pull requests read/write)`)
}

// ---- screenshots (HZ-18, HZ-63) ----
// The farm's screenshot runner captures the screens in the repo's
// .horizon/screenshots.json (HZ-506; the only source since HZ-621) into its
// outputDir. The PNGs are gitignored (HZ-63) — a binary file has no merge
// strategy, so committing them made any two branches touching the same
// screen conflict. Instead
// farm/step_agent.py's publish_screenshots() force-pushes them as an orphan
// commit to a per-item ref ("e2e-artifacts/<item-id>"), and mergePr() below
// promotes a merged item's ref onto "e2e-baseline". Rendered here as a
// "Screenshots" section plus a diff-vs-baseline table so a reviewer sees the
// resulting UI, and what changed, without checking out the branch.

const BASELINE_REF = 'e2e-baseline'
const artifactsRef = (item) => `e2e-artifacts/${item.id.toLowerCase()}`
// Where a publish puts the shots (<name>.png), their diffs (diff/<name>.png)
// and results.json, on the artifacts ref.
export const SCREENSHOT_DIR = 'e2e/__screenshots__'

// Exported for direct unit testing; pure formatting, no network.
export function screenshotsMarkdown(files) {
  const list = Array.isArray(files) ? files : []
  const pngs = list.filter((f) => f?.type === 'file' && f.name?.endsWith('.png'))
  if (pngs.length === 0) return ''
  return [
    '',
    '## Screenshots',
    ...pngs
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => `![${f.name.replace(/\.png$/, '')}](${f.download_url})`),
  ].join('\n')
}

// download_url is ref-relative, so the images re-render that ref's current
// pixels on every push with no PR-body edit needed. Never throws: a repo
// with no e2e/__screenshots__ (404) or a GitHub hiccup (network error, 5xx)
// both just omit the section rather than blocking PR creation.
export async function fetchScreenshotsMarkdown(repo, ref) {
  try {
    const res = await gh(`/repos/${repo}/contents/${SCREENSHOT_DIR}?ref=${encodeURIComponent(ref)}`)
    if (!res.ok) return ''
    return screenshotsMarkdown(await res.json())
  } catch {
    return ''
  }
}

// HZ-508: the per-journey comparison against the last approved baseline is
// computed on the farm at every publish (farm/step_agent.py's
// publish_screenshots, via farm/capture/diff.mjs) and stored on the item's
// artifact ref as e2e/__screenshots__/results.json, in the same orphan commit
// as the shots — domain/fixtures/screenshot-results.json is a sample. Nothing
// here reads e2e-baseline any more; the table only renders what was stored.
const RESULT_STATUSES = new Set(['changed', 'new', 'removed', 'same'])

function isScreenshotResults(doc) {
  return (
    doc !== null &&
    typeof doc === 'object' &&
    Array.isArray(doc.shots) &&
    doc.shots.every(
      (s) =>
        s !== null &&
        typeof s === 'object' &&
        typeof s.name === 'string' &&
        RESULT_STATUSES.has(s.status) &&
        (s.diffRatio == null || typeof s.diffRatio === 'number') &&
        (s.diff == null || typeof s.diff === 'string') &&
        (s.error == null || typeof s.error === 'string'),
    )
  )
}

// The stored results for this item's latest publish, or null when there are
// none: no publish yet, a publish whose diff step was skipped, bad JSON or a
// wrong shape. Never throws.
export async function fetchScreenshotResults(repo, item) {
  try {
    const res = await gh(`/repos/${repo}/contents/${SCREENSHOT_DIR}/results.json?ref=${encodeURIComponent(artifactsRef(item))}`)
    if (!res.ok) return null
    const data = await res.json()
    if (typeof data?.content !== 'string') return null
    const doc = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'))
    return isScreenshotResults(doc) ? doc : null
  } catch {
    return null
  }
}

function resultCell(shot) {
  if (shot.status === 'new') return '🆕 new — please review'
  if (shot.status === 'removed') return '🗑️ removed — not captured'
  if (shot.status === 'same') return '✅ unchanged'
  if (shot.error != null || shot.diffRatio == null) return '⚠️ changed (could not compute a diff)'
  const pct = `${(shot.diffRatio * 100).toFixed(1)}% of pixels differ`
  return shot.diff ? `⚠️ changed (${pct}) — \`${shot.diff.replace(/^e2e\/__screenshots__\//, '')}\`` : `⚠️ changed (${pct})`
}

// Pure: the "vs. baseline" table for stored results, or '' (section omitted)
// when there are none. A new journey reads as "please review", never a
// failure — failing closed here would block every PR that adds a journey.
export function screenshotResultsMarkdown(results) {
  if (!isScreenshotResults(results) || results.shots.length === 0) return ''
  const rows = [...results.shots]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((shot) => `| ${shot.name} | ${resultCell(shot)} |`)
  return ['', '## Screenshot comparison vs. baseline', '', '| Journey | Result |', '| --- | --- |', ...rows].join('\n')
}

export async function compareScreenshotsMarkdown(repo, item) {
  return screenshotResultsMarkdown(await fetchScreenshotResults(repo, item))
}

// HZ-509: the Accept gate's screenshot panel reads the same ref, through the
// git data API, so every image comes from one commit's tree and is streamed
// straight from GitHub — nothing is copied anywhere. Trees are immutable, so
// their path → blob listing (metadata only, never pixels) is cached per repo
// and commit.
const TREE_CACHE_MAX = 50
const treeCache = new Map()

// e2e and unit tests only, same pattern as setPrStateForTest: canned answers
// keyed "<repo>#<item id>" (a snapshot, or null for "no publish") and by blob
// sha (a Buffer). `files`/`baselineFiles` may be plain { path: {sha, size} }.
let cannedSnapshotsForTest = null
let cannedBlobsForTest = null

const toFileMap = (files) => (files == null ? null : files instanceof Map ? files : new Map(Object.entries(files)))

export function setScreenshotSnapshotForTest(map) {
  const snapshotOf = (snap) => snap && { ...snap, files: toFileMap(snap.files) ?? new Map(), baselineFiles: toFileMap(snap.baselineFiles) }
  cannedSnapshotsForTest = map == null ? null : new Map(Object.entries(map).map(([key, snap]) => [key, snapshotOf(snap)]))
}

export function setBlobsForTest(map) {
  cannedBlobsForTest = map == null ? null : new Map(Object.entries(map))
}

// A commit's whole tree as path → { sha, size }, or null when the commit is
// gone (404/422 — e.g. an old baseline commit GitHub has since collected).
// Throws on any other failure, and on a truncated listing: a partial list
// must never pass for the whole publish.
async function fetchCommitFiles(repo, commitSha) {
  const key = `${repo}@${commitSha}`
  if (treeCache.has(key)) return treeCache.get(key)
  const commitRes = await gh(`/repos/${repo}/git/commits/${commitSha}`)
  if (commitRes.status === 404 || commitRes.status === 422) return null
  if (!commitRes.ok) throw new Error(`could not read commit ${commitSha} (GitHub returned ${commitRes.status})`)
  const treeSha = (await commitRes.json().catch(() => ({})))?.tree?.sha
  if (!SHA_RE.test(treeSha || '')) throw new Error(`GitHub returned commit ${commitSha} without a tree`)
  const treeRes = await gh(`/repos/${repo}/git/trees/${treeSha}?recursive=1`)
  if (!treeRes.ok) throw new Error(`could not read tree ${treeSha} (GitHub returned ${treeRes.status})`)
  const tree = await treeRes.json().catch(() => ({}))
  if (tree.truncated) throw new Error(`GitHub truncated the tree of ${commitSha}`)
  if (!Array.isArray(tree.tree)) throw new Error(`GitHub returned tree ${treeSha} without entries`)
  const files = new Map()
  for (const entry of tree.tree) {
    if (entry?.type === 'blob' && typeof entry.path === 'string' && SHA_RE.test(entry.sha || '')) {
      files.set(entry.path, { sha: entry.sha, size: typeof entry.size === 'number' ? entry.size : 0 })
    }
  }
  treeCache.set(key, files)
  if (treeCache.size > TREE_CACHE_MAX) treeCache.delete(treeCache.keys().next().value)
  return files
}

// One consistent read of the item's latest publish: { commit, results, files,
// baselineFiles }, or null when there is nothing to show (no publish, no
// results.json, a bad one, or no GitHub token). baselineFiles is null when the
// stored baseline commit can't be read. Throws when GitHub fails otherwise.
export async function fetchScreenshotSnapshot(repo, item) {
  const key = `${repo}#${item.id}`
  if (cannedSnapshotsForTest) return cannedSnapshotsForTest.has(key) ? cannedSnapshotsForTest.get(key) : null
  if (!getToken()) return null
  const refRes = await gh(`/repos/${repo}/git/ref/${encodeURIComponent(`heads/${artifactsRef(item)}`)}`)
  if (refRes.status === 404) return null
  if (!refRes.ok) throw new Error(`could not read ${artifactsRef(item)} (GitHub returned ${refRes.status})`)
  const commit = (await refRes.json().catch(() => ({})))?.object?.sha
  if (!SHA_RE.test(commit || '')) throw new Error(`GitHub returned ${artifactsRef(item)} without a commit sha`)
  const files = await fetchCommitFiles(repo, commit)
  const resultsEntry = files?.get(`${SCREENSHOT_DIR}/results.json`)
  if (!resultsEntry) return null
  let results
  try {
    results = JSON.parse((await fetchBlob(repo, resultsEntry.sha)).toString('utf8'))
  } catch (err) {
    if (err instanceof SyntaxError) return null
    throw err
  }
  if (!isScreenshotResults(results)) return null
  const baselineFiles = SHA_RE.test(results.baseline || '') ? await fetchCommitFiles(repo, results.baseline) : null
  return { commit, results, files, baselineFiles }
}

// One blob's raw bytes, by its sha — only ever a sha read from a tree above.
export async function fetchBlob(repo, sha) {
  if (cannedBlobsForTest) {
    if (!cannedBlobsForTest.has(sha)) throw new Error(`no canned blob ${sha}`)
    return cannedBlobsForTest.get(sha)
  }
  if (!SHA_RE.test(sha || '')) throw new Error('fetchBlob needs a full blob sha')
  const res = await gh(`/repos/${repo}/git/blobs/${sha}`, { headers: { Accept: 'application/vnd.github.raw' } })
  if (!res.ok) throw new Error(`could not read blob ${sha} (GitHub returned ${res.status})`)
  return Buffer.from(await res.arrayBuffer())
}

// The gallery and the table sit between these markers in the PR body, so each
// publish can replace exactly that section and leave the rest as written.
export const SCREENSHOTS_START = '<!-- horizon:screenshots:start -->'
export const SCREENSHOTS_END = '<!-- horizon:screenshots:end -->'

export async function screenshotsSection(repo, item) {
  const [screenshots, comparison] = await Promise.all([
    fetchScreenshotsMarkdown(repo, artifactsRef(item)),
    compareScreenshotsMarkdown(repo, item),
  ])
  return [SCREENSHOTS_START, ...(screenshots ? [screenshots] : []), ...(comparison ? [comparison] : []), SCREENSHOTS_END].join(
    '\n',
  )
}

// Pure: `body` with its marked section replaced by `section`, or with
// `section` appended once when the body has no (complete) marker pair.
export function spliceScreenshotsSection(body, section) {
  const text = typeof body === 'string' ? body : ''
  const start = text.indexOf(SCREENSHOTS_START)
  const end = start === -1 ? -1 : text.indexOf(SCREENSHOTS_END, start)
  if (end === -1) return `${text}${text ? '\n\n' : ''}${section}`
  return text.slice(0, start) + section + text.slice(end + SCREENSHOTS_END.length)
}

// Best-effort: rewrites an open PR's screenshot section from the latest
// publish. Never throws — a stale table must not fail the implement run.
export async function refreshPrScreenshots(item, prNumber, section) {
  try {
    const repo = item.repo
    const prRes = await gh(`/repos/${repo}/pulls/${prNumber}`)
    if (!prRes.ok) return
    const body = (await prRes.json())?.body
    const next = spliceScreenshotsSection(body, section ?? (await screenshotsSection(repo, item)))
    if (next === body) return
    await gh(`/repos/${repo}/pulls/${prNumber}`, { method: 'PATCH', body: JSON.stringify({ body: next }) })
  } catch {
    // best-effort, as above
  }
}

// Best-effort: deletes an item's artifact ref once it's no longer needed
// (merged into the baseline, the PR closed unmerged, or the item abandoned) —
// bounds storage to one ref per currently-open PR plus the one baseline ref.
// Never throws: a missing ref (404) or a network error is ignored.
export async function deleteArtifactRef(repo, item) {
  await gh(`/repos/${repo}/git/refs/${encodeURIComponent(`heads/${artifactsRef(item)}`)}`, { method: 'DELETE' }).catch(
    () => {},
  )
}

// HZ-513: the daily sweep behind deleteArtifactRef — catches refs whose item
// closed some way that never called it (merged on GitHub, closed as an issue,
// deleted). Only ever touches refs under ARTIFACTS_PREFIX, so BASELINE_REF and
// code branches are out of reach. Runs at most once per ARTIFACTS_PRUNE_MS,
// remembered in sync_cursor so a restart doesn't re-run it. Best-effort: a
// failed list or delete logs a warning and moves on.
const ARTIFACTS_PREFIX = 'refs/heads/e2e-artifacts/'
const ARTIFACTS_PRUNE_KEY = 'artifacts-prune'
export const ARTIFACTS_PRUNE_MS = 24 * 60 * 60 * 1000
const getCursorSyncedAt = db.prepare('SELECT last_synced_at FROM sync_cursor WHERE key = ?')
const artifactItem = db.prepare(
  'SELECT id, kind, cursor, abandoned_at, merged_at FROM work_item WHERE repo = ? AND lower(id) = ?',
)

// Why an artifacts ref's item no longer needs it, or null to keep the ref.
function artifactPruneReason(row) {
  if (!row) return 'unknown item'
  if (row.abandoned_at) return 'abandoned'
  if (row.merged_at) return 'merged'
  let end
  try {
    end = endIndex(itemKindOf(row))
  } catch {
    return null // an unrecognised kind: keep rather than guess
  }
  return row.cursor >= end ? 'closed' : null
}

async function listArtifactRefs(repo) {
  const refs = []
  for (let page = 1; ; page++) {
    const res = await gh(`/repos/${repo}/git/matching-refs/heads/e2e-artifacts/?per_page=100&page=${page}`)
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`)
    const batch = await res.json()
    if (!Array.isArray(batch)) throw new Error('GitHub returned no ref list')
    refs.push(...batch)
    if (batch.length < 100) return refs
  }
}

export async function pruneArtifactRefs(log, now = Date.now()) {
  const last = getCursorSyncedAt.get(ARTIFACTS_PRUNE_KEY)?.last_synced_at
  if (last && now - msOf(last) < ARTIFACTS_PRUNE_MS) return null
  if (store.listRepos().length === 0) return null
  setCursor.run(ARTIFACTS_PRUNE_KEY, null)
  let deleted = 0
  for (const { repo } of store.listRepos()) {
    let refs
    try {
      refs = await listArtifactRefs(repo)
    } catch (err) {
      log?.warn(`could not list e2e-artifacts refs in ${repo}: ${err.message}`)
      continue
    }
    for (const { ref } of refs) {
      if (typeof ref !== 'string' || !ref.startsWith(ARTIFACTS_PREFIX)) continue
      const suffix = ref.slice(ARTIFACTS_PREFIX.length)
      if (!suffix || suffix.includes('/')) continue
      const why = artifactPruneReason(artifactItem.get(repo, suffix.toLowerCase()))
      if (!why) continue
      try {
        const res = await gh(`/repos/${repo}/git/refs/${encodeURIComponent(`heads/e2e-artifacts/${suffix}`)}`, {
          method: 'DELETE',
        })
        if (!res.ok && res.status !== 404) throw new Error(`GitHub returned ${res.status}`)
        deleted++
        log?.info(`deleted e2e-artifacts/${suffix} in ${repo} (${why})`)
      } catch (err) {
        log?.warn(`could not delete e2e-artifacts/${suffix} in ${repo}: ${err.message}`)
      }
    }
  }
  log?.info(`artifacts prune: ${deleted} ref(s) deleted`)
  return { deleted }
}

// Open the PR for a branch a real agent already pushed (the farm's Eng agent
// owns the code; this side owns the PR mechanics). Screenshots and the
// baseline comparison are read from the item's artifact ref, never the code
// branch — that's what lets two PRs touch the same journey without conflict.
// HZ-508: runs after every implement run, so a rework whose PR is already
// open (the 422 path) refreshes that PR's screenshot section in place.
export async function createPrFromBranch(item, branch, { manualChecks = null } = {}) {
  const repo = item.repo
  const repoRes = await gh(`/repos/${repo}`)
  if (!repoRes.ok) throw new Error(`could not read the repository (${repoRes.status})`)
  const base = (await repoRes.json()).default_branch

  const section = await screenshotsSection(repo, item)

  const prRes = await gh(`/repos/${repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: `${item.id}: ${item.title}`,
      head: branch,
      base,
      body: [
        item.issue != null ? `Relates to #${item.issue}.` : '',
        '',
        '## Success metric',
        item.metric || '_(none)_',
        '',
        '## Guardrails',
        item.guardrails || '_(defaults apply)_',
        // HZ-345: the Eng agent's statement for each Manual metric line.
        ...(manualChecks ? ['', '## Manual checks', manualChecks] : []),
        section,
        '',
        `_Implemented by the Horizon Eng agent; opened for the “Accept the code” gate · ${itemLink(item)}._`,
      ].join('\n'),
    }),
  })
  if (prRes.ok) return prRes.json()
  if (prRes.status === 422) {
    const open = await gh(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${repo.split('/')[0]}:${branch}`)}`)
    if (open.ok) {
      const prs = await open.json()
      if (prs.length > 0) {
        await refreshPrScreenshots(item, prs[0].number, section)
        return prs[0]
      }
    }
  }
  throw new Error(`could not open the pull request (${prRes.status})`)
}

// HZ-510: promotes a merged item's approved screenshots into e2e-baseline,
// screen by screen. One commit on the current baseline head (base_tree, so
// every other path keeps its blob) holds only the shots the owner approved at
// Accept the code: an approved changed/new shot points at the artifacts blob
// (reused by sha, never re-uploaded), an approved removed shot is deleted, and
// anything unapproved is left as it was. The ref moves with force: false; a
// rejected (non-fast-forward) move rebuilds on the new head, so two merges
// landing together keep each other's shots. With no e2e-baseline yet, the
// first promotion seeds it with only the approved shots.
//
// `approvals` is a Set of approved screen names (screenshots.mergeApprovals);
// null means they could not be read, which fails closed. Only top-level shot
// PNGs are ever promoted — never results.json or diff/*. Writes only
// e2e-baseline, and deletes only this item's artifacts ref, after success. On
// a failure that ref is kept until the daily prune (pruneArtifactRefs) drops
// it as merged.
const PROMOTE_ATTEMPTS = 3
const SHOT_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/

async function ghJson(step, path, options) {
  const res = await gh(path, options)
  if (!res.ok) throw new Error(`${step} returned ${res.status}`)
  return res.json()
}

// Pure: the tree entries promoting `approvals` from `results`. `artifactFiles`
// and `baselineFiles` are path → { sha } maps (baselineFiles null when there
// is no baseline yet). Returns { entries, skipped }: skipped names an approved
// changed/new shot whose image is missing from the publish — it keeps its
// prior baseline blob rather than failing every other shot's promotion.
function promotionEntries(results, approvals, artifactFiles, baselineFiles) {
  const entries = []
  const skipped = []
  const seen = new Set()
  for (const shot of results.shots) {
    if (!approvals.has(shot.name) || seen.has(shot.name) || !SHOT_NAME_RE.test(shot.name)) continue
    seen.add(shot.name)
    const path = `${SCREENSHOT_DIR}/${shot.name}.png`
    if (shot.status === 'changed' || shot.status === 'new') {
      const blob = artifactFiles.get(path)?.sha
      if (blob) entries.push({ path, mode: '100644', type: 'blob', sha: blob })
      else skipped.push(shot.name)
    } else if (shot.status === 'removed' && baselineFiles?.has(path)) {
      entries.push({ path, mode: '100644', type: 'blob', sha: null })
    }
  }
  return { entries, skipped }
}

async function promoteBaseline(item, approvals, log) {
  const repo = item.repo
  const refRes = await gh(`/repos/${repo}/git/ref/${encodeURIComponent(`heads/${artifactsRef(item)}`)}`)
  if (refRes.status === 404) return null // this item never published screenshots — nothing to promote
  if (!refRes.ok) throw new Error(`reading ${artifactsRef(item)} returned ${refRes.status}`)
  if (!approvals) throw new Error('approvals unavailable')
  const artifactSha = (await refRes.json())?.object?.sha
  const artifactFiles = SHA_RE.test(artifactSha || '') ? await fetchCommitFiles(repo, artifactSha) : null
  if (!artifactFiles) throw new Error(`${artifactsRef(item)} has no readable commit`)
  const resultsEntry = artifactFiles.get(`${SCREENSHOT_DIR}/results.json`)
  if (!resultsEntry) throw new Error('no results.json')
  const results = JSON.parse((await fetchBlob(repo, resultsEntry.sha)).toString('utf8'))
  if (!isScreenshotResults(results)) throw new Error('results.json has the wrong shape')

  const baselinePath = `/repos/${repo}/git/refs/${encodeURIComponent(`heads/${BASELINE_REF}`)}`
  let lastRefusal = ''
  for (let attempt = 0; attempt < PROMOTE_ATTEMPTS; attempt++) {
    const headRes = await gh(`/repos/${repo}/git/ref/${encodeURIComponent(`heads/${BASELINE_REF}`)}`)
    if (!headRes.ok && headRes.status !== 404) throw new Error(`reading ${BASELINE_REF} returned ${headRes.status}`)
    const head = headRes.ok ? (await headRes.json())?.object?.sha : null
    if (headRes.ok && !SHA_RE.test(head || '')) throw new Error(`GitHub returned ${BASELINE_REF} without a commit sha`)
    let baseTree = null
    let baselineFiles = null
    if (head) {
      baseTree = (await ghJson('reading the baseline commit', `/repos/${repo}/git/commits/${head}`))?.tree?.sha
      if (!SHA_RE.test(baseTree || '')) throw new Error(`GitHub returned commit ${head} without a tree`)
      baselineFiles = await fetchCommitFiles(repo, head)
      if (!baselineFiles) throw new Error(`could not read commit ${head}`)
    }
    const { entries, skipped } = promotionEntries(results, approvals, artifactFiles, baselineFiles)
    if (attempt === 0) {
      for (const name of skipped) log?.warn(`${item.id}: approved screenshot ${name} has no image on ${artifactsRef(item)} — its baseline is kept`)
    }
    if (entries.length === 0) break // nothing approved to promote — no commit
    const tree = await ghJson('creating the baseline tree', `/repos/${repo}/git/trees`, {
      method: 'POST',
      body: JSON.stringify(head ? { base_tree: baseTree, tree: entries } : { tree: entries }),
    })
    const commit = await ghJson('creating the baseline commit', `/repos/${repo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message: `${item.id}: promote ${entries.length} approved screenshot(s)`,
        tree: tree.sha,
        parents: head ? [head] : [],
      }),
    })
    const moved = head
      ? await gh(baselinePath, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) })
      : await gh(`/repos/${repo}/git/refs`, {
          method: 'POST',
          body: JSON.stringify({ ref: `refs/heads/${BASELINE_REF}`, sha: commit.sha }),
        })
    if (moved.ok) {
      log?.info(`${item.id}: promoted ${entries.length} approved screenshot(s) into ${BASELINE_REF}`)
      await deleteArtifactRef(repo, item)
      return { promoted: entries.length, seeded: !head }
    }
    // 422: the head moved (or a concurrent seed won) — rebuild on the new head.
    if (moved.status !== 422) throw new Error(`moving ${BASELINE_REF} returned ${moved.status}`)
    lastRefusal = (await moved.json().catch(() => ({})))?.message || 'no message'
    if (attempt === PROMOTE_ATTEMPTS - 1) throw new Error(`${BASELINE_REF} moved ${PROMOTE_ATTEMPTS} times (last: ${lastRefusal})`)
  }
  await deleteArtifactRef(repo, item)
  return { promoted: 0, seeded: false }
}

const SHA_RE = /^[0-9a-f]{40}$/

// e2e only (HZ-183), same pattern as orchestrator.js's setConflictReplyForTest:
// the e2e server has no GitHub token, so nothing could answer getPrHead() and
// getBranchSha() for the Accept gate's pre-merge check. This holds GitHub's
// ANSWER for one PR — { repo, pr, headSha, headRef, baseRef, baseSha } — and
// nothing else: the click, the PIN, the real `python -m farm.premerge` run and
// the gate's handling of its result all stay the production ones. Null unless
// a spec sets it, through a route that exists only when HORIZON_TEST_HOOKS=1.
let cannedPrForTest = null

export function setPrStateForTest(state) {
  cannedPrForTest = state
}

// HZ-183: the commits the pre-merge check tests. Both shas come from GitHub,
// the same source mergePr's sha guard and the base re-check read, so "the
// tested head" and "the tested base" mean the same thing on every side.
export async function getPrHead(item) {
  const canned = cannedPrForTest
  if (canned && canned.repo === item.repo && canned.pr === item.pr) {
    return { sha: canned.headSha, ref: canned.headRef, baseRef: canned.baseRef }
  }
  const res = await gh(`/repos/${item.repo}/pulls/${item.pr}`)
  if (!res.ok) {
    throw new Error(
      res.status === 404 ? 'the PR was not found — was it closed on GitHub?' : `could not read PR #${item.pr} (GitHub returned ${res.status})`,
    )
  }
  const data = await res.json().catch(() => ({}))
  const sha = data?.head?.sha
  const baseRef = data?.base?.ref
  if (!SHA_RE.test(sha || '') || !baseRef) throw new Error(`GitHub returned PR #${item.pr} without a head commit or base branch`)
  return { sha, ref: data.head.ref, baseRef }
}

// The current tip of a branch. Read before the check (what to test against)
// and again after it (did it move while the checks ran).
export async function getBranchSha(repo, branch) {
  const canned = cannedPrForTest
  if (canned && canned.repo === repo && canned.baseRef === branch) return canned.baseSha
  const res = await gh(`/repos/${repo}/git/ref/${encodeURIComponent(`heads/${branch}`)}`)
  if (!res.ok) throw new Error(`could not read the ${branch} branch (GitHub returned ${res.status})`)
  const sha = (await res.json().catch(() => ({})))?.object?.sha
  if (!SHA_RE.test(sha || '')) throw new Error(`GitHub returned the ${branch} branch without a commit sha`)
  return sha
}

// HZ-248: whether the token can push to `repo` — one read-only GET. Never
// throws: { ok, status, push }, status null when GitHub was unreachable.
export async function getRepoPermissions(repo) {
  let res
  try {
    res = await gh(`/repos/${repo}`)
  } catch {
    return { ok: false, status: null, push: false }
  }
  if (!res.ok) return { ok: false, status: res.status, push: false }
  const data = await res.json().catch(() => null)
  return { ok: true, status: res.status, push: data?.permissions?.push === true }
}

// HZ-257: whether `baseSha` is an ancestor of (or equal to) `headSha` — so a
// test-merge of the two would be the head itself. Ancestry only: nothing here
// reads a commit status or any claim that checks passed. Throws on any
// answer it cannot read, so a caller never mistakes "unknown" for "yes". The
// canned PR's optional `ancestry` ('ahead' | 'identical' | 'behind' |
// 'diverged') answers for e2e; a canned PR without one (or with any other
// value) throws, as does any status GitHub does not document.
const COMPARE_ANCESTOR_STATUSES = new Set(['ahead', 'identical'])
const COMPARE_STATUSES = new Set(['ahead', 'identical', 'behind', 'diverged'])

export async function isAncestor(repo, baseSha, headSha) {
  if (!SHA_RE.test(baseSha || '') || !SHA_RE.test(headSha || '')) throw new Error('isAncestor needs two full commit shas')
  const canned = cannedPrForTest
  let status
  if (canned && canned.repo === repo) {
    status = canned.ancestry
  } else {
    const res = await gh(`/repos/${repo}/compare/${baseSha}...${headSha}`)
    if (!res.ok) throw new Error(`could not compare ${baseSha.slice(0, 12)}...${headSha.slice(0, 12)} (GitHub returned ${res.status})`)
    status = (await res.json().catch(() => ({})))?.status
  }
  if (!COMPARE_STATUSES.has(status)) throw new Error('GitHub returned a comparison without a known status')
  return COMPARE_ANCESTOR_STATUSES.has(status)
}

// Accepting the code merges its PR (squash), removes the work branch, and —
// only here, never from a PR branch — promotes this item's approved
// screenshots (`approvals`, see promoteBaseline) into the baseline that
// future PRs compare against. A failed promotion is logged with the item id
// and never fails the merge.
//
// `sha` (HZ-183) pins the merge to the PR head the pre-merge check tested:
// GitHub refuses with 409 if the head moved since. A squash builds its own
// commit, so the tested merge commit itself is never pushed; the head pin plus
// app.js's base re-check together are what make the squash the tested tree.
export async function mergePr(item, { sha, approvals = null, log } = {}) {
  const repo = item.repo
  const res = await gh(`/repos/${repo}/pulls/${item.pr}/merge`, {
    method: 'PUT',
    body: JSON.stringify(sha ? { merge_method: 'squash', sha } : { merge_method: 'squash' }),
  })
  if (res.ok) {
    // Best-effort branch cleanup; the merge is what matters.
    await gh(`/repos/${repo}/git/refs/${encodeURIComponent(`heads/horizon/${item.id.toLowerCase()}`)}`, {
      method: 'DELETE',
    }).catch(() => {})
    await promoteBaseline(item, approvals, log).catch((err) =>
      log?.warn(`baseline promotion failed for ${item.id}: ${err.message} — ${artifactsRef(item)} is kept`),
    )
    return res.json()
  }
  const data = await res.json().catch(() => ({}))
  const message =
    res.status === 405
      ? `the PR is not mergeable (${data.message || 'conflicts or required checks blocking'})`
      : res.status === 403
        ? 'the token is not allowed to merge (Contents read/write required)'
        : res.status === 404
          ? 'the PR was not found — was it closed on GitHub?'
          : res.status === 409
            ? 'the PR head moved while the checks ran — click Accept again'
            : data.message || `GitHub returned ${res.status}`
  throw new Error(message)
}

// The commit the item's PR head points at right now, or null when the item
// has no PR (demo mode). HZ-185's forward compares it with the commit the
// last automated review read. Throws when GitHub can't answer, so a caller
// never mistakes "unknown" for "unchanged".
// HZ-236: a PR's changed files, for step 9's overlap check on an in-flight
// item that has no step-6 plan. Read-only. Callers reduce the result to file
// and function names (server/src/overlap.js); the patch text never leaves the
// server. Errors carry the status only — never a header, so never the token.
let cannedPrFilesForTest = null

// Tests only: { "<repo>#<pr>": [{ filename, patch }] } answers getPrFiles for
// those PRs without a GitHub call. Any other PR still goes to GitHub.
export function setPrFilesForTest(map) {
  cannedPrFilesForTest = map
}

export async function getPrFiles(item) {
  const key = `${item.repo}#${item.pr}`
  if (cannedPrFilesForTest && Object.hasOwn(cannedPrFilesForTest, key)) return cannedPrFilesForTest[key]
  const res = await gh(`/repos/${item.repo}/pulls/${item.pr}/files?per_page=100`)
  if (!res.ok) throw new Error(`could not read PR #${item.pr}'s changed files (GitHub returned ${res.status})`)
  const data = await res.json().catch(() => null)
  if (!Array.isArray(data)) throw new Error(`GitHub returned no file list for PR #${item.pr}`)
  return data
    .map((f) => ({ filename: typeof f?.filename === 'string' ? f.filename : '', patch: typeof f?.patch === 'string' ? f.patch : '' }))
    .filter((f) => f.filename)
}

export async function getPrHeadSha(item) {
  if (!item.repo || item.pr == null) return null
  const res = await gh(`/repos/${item.repo}/pulls/${item.pr}`)
  if (!res.ok) throw new Error(`GitHub returned ${res.status} reading PR #${item.pr}`)
  const sha = (await res.json())?.head?.sha
  if (typeof sha !== 'string' || !sha) throw new Error(`GitHub returned no head commit for PR #${item.pr}`)
  return sha
}

// ---- deploy: release ----
// The DevOps step publishes a GitHub Release. A "release published" webhook
// (server/src/deploy.js) is what actually ships it — it pulls the tag to the
// shoreward.ai host and restarts the service, no SSH needed. Publishing only
// creates the release: it never commits a file to the product repo (HZ-275 —
// a dummy workflow used to be pushed here, unreviewed, on a repo's first
// deploy).

async function freeReleaseTag(repo, base) {
  for (let i = 0; i < 25; i++) {
    const tag = i === 0 ? base : `${base}-${i + 1}`
    const res = await gh(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`)
    if (res.status === 404) return tag
  }
  throw new Error('could not find a free release tag')
}

export async function createDeployRelease(item) {
  const repo = item.repo
  const tag = await freeReleaseTag(repo, `deploy-${item.id.toLowerCase()}`)
  const res = await gh(`/repos/${repo}/releases`, {
    method: 'POST',
    body: JSON.stringify({
      tag_name: tag,
      name: `${item.id}: ${item.title}`,
      body: [
        `Automated deploy release for ${item.id} (issue #${item.issue}).`,
        item.pr != null ? `Code merged via PR #${item.pr}.` : '',
        '',
        '_Published by the Horizon DevOps agent — the self-deploy webhook will pull this to shoreward.ai._',
      ].join('\n'),
    }),
  })
  if (!res.ok) {
    throw new Error(`could not publish the release (${res.status} — check the token has Contents read/write)`)
  }
  return res.json()
}

// HZ-333: the deploy queue's calls. Errors carry the status only, never a
// header, so never the token.
export async function getPrMergeSha(item) {
  const res = await gh(`/repos/${item.repo}/pulls/${item.pr}`)
  if (!res.ok) throw new Error(`could not read PR #${item.pr} (GitHub returned ${res.status})`)
  const data = await res.json().catch(() => ({}))
  if (data?.merged !== true) throw new Error(`PR #${item.pr} is not merged`)
  if (!SHA_RE.test(data.merge_commit_sha || '')) throw new Error(`GitHub returned PR #${item.pr} without a merge commit`)
  return data.merge_commit_sha
}

// The release for `tag`, or null when there is none.
export async function findReleaseByTag(repo, tag) {
  const res = await gh(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`could not look up release ${tag} (GitHub returned ${res.status})`)
  return res.json()
}

// A batch's one release, its tag pinned to `sha` (main's head when the batch
// started) — never an item branch.
export async function createBatchRelease(repo, { tag, sha, name, body }) {
  const res = await gh(`/repos/${repo}/releases`, {
    method: 'POST',
    body: JSON.stringify({ tag_name: tag, target_commitish: sha, name, body }),
  })
  if (!res.ok) throw new Error(`could not publish release ${tag} (GitHub returned ${res.status})`)
  return res.json()
}

// Agent step results are posted to the issue so GitHub stays the
// human-readable record of what the bots did.
// Agent refinements (outcome, metric, guardrails) must reach the issue body,
// not only the database: store.upsertFromGithub() re-reads those sections from
// the body on every issue webhook, and the step comment posted right after a
// patch fires one, so a database-only refinement was overwritten seconds later
// (seen on HZ-204 and HZ-216, 2026-10-01). Only bodies already in Horizon's
// section format are rewritten; an issue written freehand on GitHub has no
// "## Success metric" heading, keeps its body, and upsert already keeps the
// database's metric for it.
const HORIZON_BODY = /^##\s+Success metric\s*$/m
export async function syncIssueBodyFields(item) {
  if (!item.repo || item.issue == null) return false
  const res = await gh(`/repos/${item.repo}/issues/${item.issue}`)
  if (!res.ok) throw new Error(`GitHub returned ${res.status} reading issue #${item.issue}`)
  const current = (await res.json()).body || ''
  if (!HORIZON_BODY.test(current)) return false
  const body = composeIssueBody({ outcome: item.desc || '', metric: item.metric || '', guardrails: item.guardrails })
  if (body === current) return false
  const upd = await gh(`/repos/${item.repo}/issues/${item.issue}`, { method: 'PATCH', body: JSON.stringify({ body }) })
  if (!upd.ok) throw new Error(`GitHub returned ${upd.status} updating issue #${item.issue}`)
  return true
}

// ---- HZ-313: a plan's cross-repo split ----

// The issue a split already filed on `repo`, found by the marker in its body,
// or null. Covers a crash between the create POST and the row's 'filed'
// write. The list endpoint, not search: search indexing lags a fresh issue.
// `since` (ISO) bounds the pages to issues touched after the split was proposed.
const SPLIT_SEARCH_MAX_PAGES = 10
export async function findSplitIssue(repo, marker, since) {
  for (let page = 1; page <= SPLIT_SEARCH_MAX_PAGES; page++) {
    const query = `state=all&since=${encodeURIComponent(since)}&per_page=100&page=${page}`
    const res = await gh(`/repos/${repo}/issues?${query}`)
    if (!res.ok) throw new Error(`GitHub returned ${res.status} listing issues on ${repo}`)
    const issues = await res.json()
    const found = issues.find((i) => !i.pull_request && (i.body || '').includes(marker))
    if (found) return found
    if (issues.length < 100) return null
  }
  return null
}

// Rewrites the item's issue body to the given outcome and metric (its
// guardrails kept). Unlike syncIssueBodyFields this also rewrites a freehand
// body: upsertFromGithub reads desc from every body, so a split's narrowed
// scope only survives the next sync once GitHub holds it.
export async function pushIssueScope(item, { desc, metric }) {
  const body = composeIssueBody({ outcome: desc || '', metric: metric || '', guardrails: item.guardrails })
  const res = await gh(`/repos/${item.repo}/issues/${item.issue}`, { method: 'PATCH', body: JSON.stringify({ body }) })
  if (!res.ok) throw new Error(`GitHub returned ${res.status} updating issue #${item.issue}`)
}

// ---- HZ-273: the caretaker's line-level ruling edits ----
// Unlike syncIssueBodyFields above, which rebuilds the whole body, these
// change only the named lines (spliceIssueBody), so every other byte of the
// issue — description, other lines, line endings — stays as it was. The
// PATCH sends `body` alone: never a title, label or state.

export async function getIssueBody(item) {
  if (!item.repo || item.issue == null) throw new Error('the item has no GitHub issue')
  const res = await gh(`/repos/${item.repo}/issues/${item.issue}`)
  if (!res.ok) throw new Error(`GitHub returned ${res.status} reading issue #${item.issue}`)
  return (await res.json()).body || ''
}

// Re-reads the body first, so an edit whose line has changed since the ruling
// was checked fails closed (err.code 'stale_body') with nothing written.
// Returns the updated issue as GitHub sent it back.
export async function patchIssueBodyLines(item, edits) {
  const spliced = spliceIssueBody(await getIssueBody(item), edits)
  if (!spliced.ok) throw Object.assign(new Error(spliced.detail), { code: spliced.code })
  const res = await gh(`/repos/${item.repo}/issues/${item.issue}`, { method: 'PATCH', body: JSON.stringify({ body: spliced.body }) })
  if (!res.ok) throw new Error(`GitHub returned ${res.status} updating issue #${item.issue}`)
  return res.json()
}

export async function postIssueComment(item, body) {
  const res = await gh(`/repos/${item.repo}/issues/${item.issue}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  })
  if (!res.ok) throw new Error(`GitHub returned ${res.status} posting a comment`)
}

// ---- issue status sync (UI → GitHub) ----
// Approving the final gate of any kind (its last step row) closes the issue
// with a summary comment. (GitHub → UI sync lives in store.upsertFromGithub.)

export async function closeIssueWithSummary(item) {
  const repo = item.repo
  const comment = [
    '✅ Closed via Horizon after the final review gate.',
    '',
    `- Code: ${item.pr != null ? `PR #${item.pr}` : '—'}`,
    `- Deploy: ${item.release_tag ? `release \`${item.release_tag}\`` : '—'}`,
    `- Success metric: ${item.metric || '—'}`,
    '',
    `_${itemLink(item)} · posted by Horizon_`,
  ].join('\n')
  await gh(`/repos/${repo}/issues/${item.issue}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: comment }),
  }) // comment is best-effort; the state change below is what matters
  const res = await gh(`/repos/${repo}/issues/${item.issue}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
  })
  if (!res.ok) {
    throw new Error(`could not close issue #${item.issue} (${res.status} — check the token has Issues read/write)`)
  }
}

// Abandoning (HZ-59) closes the issue as "not planned", distinct from the
// final-gate "completed" close above — GitHub's own state_reason enum makes
// that distinction directly. Called AFTER the DB is already marked abandoned
// (see store.abandonItem) so the webhook this PATCH triggers lands on an item
// upsertFromGithub already knows to leave alone.
export async function closeIssueAsAbandoned(item, reason) {
  const repo = item.repo
  const comment = [
    '🚫 Abandoned via Horizon — this work will not proceed.',
    '',
    `- Reason: ${reason}`,
    '',
    `_${itemLink(item)} · posted by Horizon_`,
  ].join('\n')
  await gh(`/repos/${repo}/issues/${item.issue}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: comment }),
  }) // comment is best-effort; the state change below is what matters
  const res = await gh(`/repos/${repo}/issues/${item.issue}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'closed', state_reason: 'not_planned' }),
  })
  if (!res.ok) {
    throw new Error(`could not close issue #${item.issue} (${res.status} — check the token has Issues read/write)`)
  }
}

// ---- issue-comment ingestion (GitHub → feedback) ----
// Humans steer agents by commenting on the issue. Conflict policy: SQLite is
// authoritative for lifecycle position (ingestion never touches cursor —
// only addFeedback's supersede-and-rerun path does, through the runner);
// GitHub is authoritative for item existence and human text.

// Every comment Horizon posts carries this marker in its footer.
const HORIZON_FOOTER = 'posted by Horizon_'

// Echo-loop guard, three layers: bot accounts, our own token identity, and
// the footer marker every Horizon-authored comment carries. Without these,
// mirrored step results would be re-ingested as feedback on the next poll —
// an infinite loop that also burns agent sessions.
export function isOwnComment(comment) {
  if (comment?.user?.type === 'Bot') return true
  const ourLogin = getSetting('github_login')
  if (ourLogin && comment?.user?.login === ourLogin) return true
  if ((comment?.body || '').includes(HORIZON_FOOTER)) return true
  return false
}

// Returns true when the comment produced a new feedback row.
export function ingestComment(repoFullName, issueNumber, comment, log) {
  if (!comment?.body || issueNumber == null) return false
  if (isOwnComment(comment)) return false
  const row = db.prepare('SELECT id FROM work_item WHERE repo = ? AND issue = ?').get(repoFullName, issueNumber)
  if (!row) return false // not an item we track
  const result = store.addFeedback(row.id, {
    message: comment.body.slice(0, 2000),
    source: 'github',
    ghCommentId: comment.id ?? null,
  })
  if (result.error) {
    if (result.error !== 'closed') log?.warn(`comment on ${repoFullName}#${issueNumber} not ingested: ${result.error}`)
    return false
  }
  return !result.duplicate
}

// Installs that saved their token before the login was recorded need it
// backfilled — otherwise the own-login guard layer is silently inert.
export async function ensureGithubLogin() {
  const existing = getSetting('github_login')
  if (existing) return existing
  const token = getToken()
  if (!token) return null
  const check = await validateToken(token)
  if (!check.ok) return null
  setSetting('github_login', check.login)
  return check.login
}

const getCommentCursor = db.prepare('SELECT last_synced_at FROM sync_cursor WHERE key = ?')
const setCommentCursor = db.prepare(`
  INSERT INTO sync_cursor (key, etag, last_synced_at) VALUES (?, NULL, ?)
  ON CONFLICT(key) DO UPDATE SET last_synced_at = excluded.last_synced_at
`)

// Poll fallback for setups without a webhook tunnel. `since` matches
// GitHub's updated_at, so *edited* old comments re-arrive — they are then
// dropped by the gh_comment_id dedup (edits are deliberately not re-ingested).
// The cursor advances only after the page ingested successfully.
export async function pollComments(repo, log) {
  const key = `comments:${repo}`
  const since = getCommentCursor.get(key)?.last_synced_at
  if (!since) {
    // First run on an existing install: baseline to now instead of replaying
    // the issue history as fresh feedback.
    setCommentCursor.run(key, new Date().toISOString())
    return { changed: 0, baselined: true }
  }
  const url =
    `https://api.github.com/repos/${repo}/issues/comments` +
    `?sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`
  const res = await fetch(url, { headers: ghHeaders(getToken()) })
  if (!res.ok) {
    log?.warn(`GitHub comment poll failed for ${repo}: ${res.status}`)
    return { changed: 0, error: `GitHub returned ${res.status}` }
  }
  const comments = await res.json()
  let changed = 0
  let latest = since
  for (const comment of comments) {
    const issueNumber = Number((comment.issue_url || '').split('/').pop())
    if (ingestComment(repo, Number.isInteger(issueNumber) ? issueNumber : null, comment, log)) changed++
    if (comment.updated_at && comment.updated_at > latest) latest = comment.updated_at
  }
  if (latest !== since) setCommentCursor.run(key, latest)
  return { changed }
}

export async function pollRepo(repo, log) {
  const url = `https://api.github.com/repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=100`
  const headers = ghHeaders(getToken())
  const etag = getCursor.get(`issues:${repo}`)?.etag
  if (etag) headers['If-None-Match'] = etag

  const res = await fetch(url, { headers })
  if (res.status === 304) {
    lastByRepo[repo] = { at: new Date().toISOString(), status: 304, changed: 0, error: null }
    return lastByRepo[repo] // unchanged; didn't count against rate limit
  }
  if (!res.ok) {
    const body = await res.text().then((t) => t.slice(0, 200))
    log?.warn(`GitHub poll failed for ${repo}: ${res.status} ${body}`)
    lastByRepo[repo] = { at: new Date().toISOString(), status: res.status, changed: 0, error: `GitHub returned ${res.status}` }
    return lastByRepo[repo]
  }

  const issues = await res.json()
  let changed = 0
  for (const issue of issues) {
    if (store.upsertFromGithub(issue, repo)) changed++
  }
  setCursor.run(`issues:${repo}`, res.headers.get('etag'))
  lastByRepo[repo] = { at: new Date().toISOString(), status: 200, changed, error: null }
  return lastByRepo[repo]
}

// ---- PR-state sync (UI approve merges; GitHub merges must flow back) ----
// A PR merged directly on GitHub approves the "Accept the code" gate; a PR
// closed without merging sends the item back to the implement step.

export function handlePrStateChange(repoFullName, prNumber, { merged, state }, log) {
  const item = db
    .prepare('SELECT id, cursor FROM work_item WHERE repo = ? AND pr = ?')
    .get(repoFullName, prNumber)
  if (!item || item.cursor !== ACCEPT_GATE_INDEX) return false
  if (merged) {
    log?.info(`PR #${prNumber} merged on GitHub — accepting the code for ${item.id}`)
    return !store.approveGateFromGithub(item.id).error
  }
  if (state === 'closed') {
    log?.info(`PR #${prNumber} closed unmerged on GitHub — sending ${item.id} back`)
    // Fire-and-forget (this function stays sync, matching its existing
    // callers/tests): the abandoned PR's screenshots have nothing left to be
    // compared against, so free the ref rather than let it linger forever —
    // the next implement attempt just republishes it under the same name.
    deleteArtifactRef(repoFullName, item).catch(() => {})
    return !store.requestChanges(item.id, 'Accept the code', `PR #${prNumber} was closed on GitHub without merging`).error
  }
  return false
}

// Surface mergeability so the accept gate can offer a one-click
// conflict-resolution rework (GitHub computes it async; null = unknown).
// Returns the flag written: 1 mergeable, 0 conflicted, null unknown.
export function recordPrMergeable(itemId, pr) {
  const flag = pr.merged || pr.state === 'closed' || pr.mergeable == null ? null : pr.mergeable ? 1 : 0
  const row = db.prepare('SELECT pr_mergeable FROM work_item WHERE id = ?').get(itemId)
  if (row && (row.pr_mergeable ?? null) !== flag) {
    db.prepare("UPDATE work_item SET pr_mergeable = ?, updated_at = datetime('now') WHERE id = ?").run(flag, itemId)
    store.notifyChange()
  }
  return flag
}

// HZ-235: a read-only re-read of one PR's mergeability, for the main-moved
// scan (autoResolve.js) — it must not wait for the next poll tick. Only the
// flag is recorded; a PR GitHub reports merged or closed is left to
// pollPrStates/handlePrStateChange, so this never acts on a gate.
export async function refreshPrMergeable(itemId, repo, prNumber) {
  const res = await gh(`/repos/${repo}/pulls/${prNumber}`)
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for PR #${prNumber}`)
  return recordPrMergeable(itemId, await res.json())
}

// HZ-235: the PRs merged into main by `sha`, so a main move the poll noticed
// (no webhook) can still name the merges behind it. [] when GitHub can't say.
// HZ-425: "main" is the repo's default branch.
export async function prsForCommit(repo, sha) {
  const res = await gh(`/repos/${repo}/commits/${encodeURIComponent(sha)}/pulls`)
  if (!res.ok) return []
  const prs = await res.json().catch(() => [])
  const branch = defaultBranchOf(repo)
  return Array.isArray(prs) ? prs.filter((pr) => pr?.merged_at && pr?.base?.ref === branch).map((pr) => pr.number) : []
}

// ---- default branch (HZ-425) ----
// Each connected repo's GitHub default branch lives in project_repo (store.js):
// read on connect, set by a signed `repository` webhook, and re-read by the
// poll once the last read is DEFAULT_BRANCH_TTL_MS old.
export const DEFAULT_BRANCH_TTL_MS = 24 * 60 * 60_000

// The branch to read for `repo`, from the cache only — never a GitHub call.
// 'main', as before HZ-425, for a repo not connected or not read yet.
export function defaultBranchOf(repo) {
  return store.getDefaultBranch(repo)?.branch ?? 'main'
}

// Whether a read at `at` (datetime('now') form, or null) is due again.
export function defaultBranchStale(at, now = Date.now()) {
  return !at || now - msOf(at) > DEFAULT_BRANCH_TTL_MS
}

// One GET /repos/:r per connected repo whose branch is unread or stale. A
// failed read logs and keeps the old value; the next poll tries again.
export async function refreshDefaultBranches(log, now = Date.now()) {
  for (const { repo } of store.listRepos()) {
    if (!defaultBranchStale(store.getDefaultBranch(repo)?.at, now)) continue
    try {
      const res = await gh(`/repos/${repo}`)
      if (!res.ok) throw new Error(`GitHub returned ${res.status}`)
      const branch = (await res.json().catch(() => null))?.default_branch
      if (!store.setDefaultBranch(repo, branch, now)) throw new Error('GitHub returned no default branch')
    } catch (err) {
      log?.warn(`could not read the default branch of ${repo}: ${err.message}`)
    }
  }
}

// HZ-235: called with (repo, mainSha) for every connected repo at the end of
// each poll tick — the poll fallback for "main moved". A listener rather than
// an import, so autoResolve.js (which imports this module) is not imported
// back. Null until autoResolve.startAutoResolve() sets it.
let mainHeadListener = null

export function setMainHeadListener(fn) {
  mainHeadListener = fn
}

async function pollPrStates(log) {
  let changed = 0
  const waiting = db
    .prepare('SELECT id, repo, pr FROM work_item WHERE pr IS NOT NULL AND repo IS NOT NULL AND cursor = ?')
    .all(ACCEPT_GATE_INDEX)
  for (const item of waiting) {
    try {
      const res = await gh(`/repos/${item.repo}/pulls/${item.pr}`)
      if (!res.ok) continue
      const pr = await res.json()
      if (handlePrStateChange(item.repo, item.pr, { merged: !!pr.merged, state: pr.state }, log)) changed++
      recordPrMergeable(item.id, pr)
    } catch {
      // transient; next poll retries
    }
  }
  return changed
}

export async function pollOnce(log) {
  let changed = 0
  await refreshDefaultBranches(log)
  for (const { repo } of store.listRepos()) {
    try {
      const result = await pollRepo(repo, log)
      changed += result.changed
      const comments = await pollComments(repo, log)
      changed += comments.changed
    } catch (err) {
      log?.warn(`GitHub poll error for ${repo}: ${err.message}`)
      lastByRepo[repo] = { at: new Date().toISOString(), status: 'network_error', changed: 0, error: err.message }
    }
  }
  changed += await pollPrStates(log) // PRs merged/closed directly on GitHub
  if (mainHeadListener) {
    for (const { repo } of store.listRepos()) {
      const sha = await getBranchSha(repo, defaultBranchOf(repo)).catch(() => null)
      if (sha) mainHeadListener(repo, sha)
    }
  }
  return { changed }
}

export function startPolling(log) {
  if (store.listRepos().length === 0) log.info('GitHub sync not configured — connect repos from the Admin page')
  // Backfill the token identity for the comment echo guard on older installs.
  ensureGithubLogin().catch((err) => log.warn(`could not resolve the GitHub login: ${err.message}`))
  let inFlight = false
  const tick = async () => {
    if (inFlight || store.listRepos().length === 0) return
    inFlight = true
    try {
      const result = await pollOnce(log)
      if (result.changed > 0) log.info(`GitHub poll: ${result.changed} item(s) updated`)
    } finally {
      inFlight = false
    }
  }
  tick()
  setInterval(tick, POLL_INTERVAL_MS).unref()
  const prune = () => pruneArtifactRefs(log).catch((err) => log.warn(`artifacts prune failed: ${err.message}`))
  prune()
  setInterval(prune, ARTIFACTS_PRUNE_MS).unref()
}

export function verifySignature(secret, rawBody, signatureHeader) {
  if (!signatureHeader?.startsWith('sha256=')) return false
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader))
  } catch {
    return false
  }
}
