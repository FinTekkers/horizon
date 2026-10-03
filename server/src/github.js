// GitHub issue sync — event-based via webhooks, with an ETag-conditional
// polling fallback for anything missed (and for setups without a public
// endpoint/tunnel). Both paths funnel into store.upsertFromGithub().
//
// Repo/token come from settings.js (UI-configurable, env fallback), so sync
// can be enabled at runtime without a restart.

import crypto from 'node:crypto'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { db } from './db.js'
import * as store from './store.js'
import { getToken, getSetting, setSetting } from './settings.js'
import { POLL_INTERVAL_MS, UI_URL } from './config.js'
import { ACCEPT_GATE_INDEX } from '../../domain/js/lifecycle.js'
import { PRIORITY } from '../../domain/js/priorities.js'
import { PRIORITY_LABEL_RE, priorityLabelName } from './priorityLabels.js'

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
// full_name so case variants can't be connected twice.
export async function validateRepo(repo, token) {
  const res = await fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders(token) })
  if (res.ok) return { ok: true, fullName: (await res.json()).full_name }
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

export async function createIssue(repo, { title, outcome, metric, guardrails, priority }) {
  const token = getToken()
  const label = await ensurePriorityLabel(repo, token, priority)
  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: ghHeaders(token),
    body: JSON.stringify({
      title,
      body: composeIssueBody({ outcome, metric, guardrails }),
      labels: label ? [label] : [],
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
// e2e/fixtures/test-base.js's captureScreenshot() writes fixed-name PNGs to
// e2e/__screenshots__/ during the implement step's e2e run. They are
// gitignored (HZ-63) — a binary file has no merge strategy, so committing
// them made any two branches touching the same journey conflict. Instead
// farm/step_agent.py's publish_screenshots() force-pushes them as an orphan
// commit to a per-item ref ("e2e-artifacts/<item-id>"), and mergePr() below
// promotes a merged item's ref onto "e2e-baseline". Rendered here as a
// "Screenshots" section plus a diff-vs-baseline table so a reviewer sees the
// resulting UI, and what changed, without checking out the branch.

const BASELINE_REF = 'e2e-baseline'
const artifactsRef = (item) => `e2e-artifacts/${item.id.toLowerCase()}`

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
    const res = await gh(`/repos/${repo}/contents/e2e/__screenshots__?ref=${encodeURIComponent(ref)}`)
    if (!res.ok) return ''
    return screenshotsMarkdown(await res.json())
  } catch {
    return ''
  }
}

// null = the ref/dir doesn't exist (missing baseline, or an item that hasn't
// published yet) — distinct from [] (the dir exists but is empty), and never
// throws: a 404 or network error both read as "nothing to compare against".
async function fetchScreenshotListing(repo, ref) {
  try {
    const res = await gh(`/repos/${repo}/contents/e2e/__screenshots__?ref=${encodeURIComponent(ref)}`)
    if (!res.ok) return null
    const list = await res.json()
    return Array.isArray(list) ? list.filter((f) => f?.type === 'file' && f.name?.endsWith('.png')) : []
  } catch {
    return null
  }
}

async function fetchFileBase64(repo, path, ref) {
  const res = await gh(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`)
  if (!res.ok) return null
  const data = await res.json().catch(() => null)
  return typeof data?.content === 'string' ? Buffer.from(data.content, 'base64') : null
}

// Pixel-exact comparison across font rendering/antialiasing is noise a
// reviewer learns to ignore, so two tolerances apply: pixelmatch's own
// per-pixel `threshold` absorbs antialiasing at the pixel level, and
// DIFF_RATIO_TOLERANCE absorbs the handful of stray pixels that still differ
// across an otherwise-identical image. Pure/sync/no network — unit-testable
// directly with small PNG buffers.
const DIFF_RATIO_TOLERANCE = 0.01

export function diffPngBuffers(bufferA, bufferB) {
  const a = PNG.sync.read(bufferA)
  const b = PNG.sync.read(bufferB)
  if (a.width !== b.width || a.height !== b.height) return { changed: true, diffRatio: 1 }
  const { width, height } = a
  const diffPixels = pixelmatch(a.data, b.data, null, width, height, { threshold: 0.1 })
  const diffRatio = diffPixels / (width * height)
  return { changed: diffRatio > DIFF_RATIO_TOLERANCE, diffRatio }
}

// Renders a per-journey table comparing this item's just-published
// screenshots against the last approved baseline. A missing baseline (first
// run, a newly added journey, or a renamed file) reads as "new, please
// review" — never a failure, since failing closed here would block every PR
// that adds a journey. The baseline itself only ever moves in mergePr(),
// never here, so a PR can't invalidate the thing it's compared against.
// Never throws: any failure (network, malformed PNG, etc.) just omits the
// section, same contract as fetchScreenshotsMarkdown.
export async function compareScreenshotsMarkdown(repo, item) {
  try {
    const [current, baseline] = await Promise.all([
      fetchScreenshotListing(repo, artifactsRef(item)),
      fetchScreenshotListing(repo, BASELINE_REF),
    ])
    if (!current || current.length === 0) return ''
    const baselineByName = new Map((baseline || []).map((f) => [f.name, f]))
    const rows = []
    for (const file of [...current].sort((a, b) => a.name.localeCompare(b.name))) {
      const name = file.name.replace(/\.png$/, '')
      const base = baselineByName.get(file.name)
      if (!base) {
        rows.push(`| ${name} | 🆕 new — please review |`)
        continue
      }
      if (base.sha === file.sha) {
        rows.push(`| ${name} | ✅ unchanged |`)
        continue
      }
      let diff
      try {
        const [curBuf, baseBuf] = await Promise.all([
          fetchFileBase64(repo, file.path, artifactsRef(item)),
          fetchFileBase64(repo, base.path, BASELINE_REF),
        ])
        diff = curBuf && baseBuf ? diffPngBuffers(curBuf, baseBuf) : null
      } catch {
        diff = null
      }
      rows.push(
        !diff
          ? `| ${name} | ⚠️ changed (could not compute a diff) |`
          : diff.changed
            ? `| ${name} | ⚠️ changed (${(diff.diffRatio * 100).toFixed(1)}% of pixels differ) |`
            : `| ${name} | ✅ unchanged (within tolerance) |`,
      )
    }
    if (rows.length === 0) return ''
    return ['', '## Screenshot comparison vs. baseline', '', '| Journey | Result |', '| --- | --- |', ...rows].join('\n')
  } catch {
    return ''
  }
}

// Best-effort: deletes an item's artifact ref once it's no longer needed
// (merged into the baseline, or the PR closed unmerged) — bounds storage to
// one ref per currently-open PR plus the one baseline ref.
async function deleteArtifactRef(repo, item) {
  await gh(`/repos/${repo}/git/refs/${encodeURIComponent(`heads/${artifactsRef(item)}`)}`, { method: 'DELETE' }).catch(
    () => {},
  )
}

// Open the PR for a branch a real agent already pushed (the farm's Eng agent
// owns the code; this side owns the PR mechanics). Screenshots and the
// baseline comparison are read from the item's artifact ref, never the code
// branch — that's what lets two PRs touch the same journey without conflict.
export async function createPrFromBranch(item, branch) {
  const repo = item.repo
  const repoRes = await gh(`/repos/${repo}`)
  if (!repoRes.ok) throw new Error(`could not read the repository (${repoRes.status})`)
  const base = (await repoRes.json()).default_branch

  const [screenshots, comparison] = await Promise.all([
    fetchScreenshotsMarkdown(repo, artifactsRef(item)),
    compareScreenshotsMarkdown(repo, item),
  ])

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
        ...(screenshots ? [screenshots] : []),
        ...(comparison ? [comparison] : []),
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
      if (prs.length > 0) return prs[0]
    }
  }
  throw new Error(`could not open the pull request (${prRes.status})`)
}

// Promotes a merged item's artifact ref to be the new baseline. This is a
// plain overwrite of e2e-baseline with a value that's a pure function of the
// item being merged — not a read-modify-write of the baseline's prior
// contents — so two merges landing close together are still safe: each sets
// the baseline to *its own* screenshots, and last-writer-wins is an
// acceptable outcome for "what does the baseline show right now" (unlike a
// counter or list, there's no lost-update to corrupt). Best-effort: a
// promotion failure never fails the merge, since the merge itself is what
// matters — the baseline just stays one revision stale until the next merge.
async function promoteBaseline(item) {
  const repo = item.repo
  const refRes = await gh(`/repos/${repo}/git/ref/${encodeURIComponent(`heads/${artifactsRef(item)}`)}`)
  if (!refRes.ok) return // this item never published screenshots — nothing to promote
  const sha = (await refRes.json()).object.sha
  const update = await gh(`/repos/${repo}/git/refs/${encodeURIComponent(`heads/${BASELINE_REF}`)}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha, force: true }),
  })
  if (!update.ok) {
    // Baseline ref doesn't exist yet (first-ever merge on this repo) — create it.
    await gh(`/repos/${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${BASELINE_REF}`, sha }),
    }).catch(() => {})
  }
  await deleteArtifactRef(repo, item)
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
// only here, never from a PR branch — promotes this item's screenshots to be
// the new baseline that future PRs compare against.
//
// `sha` (HZ-183) pins the merge to the PR head the pre-merge check tested:
// GitHub refuses with 409 if the head moved since. A squash builds its own
// commit, so the tested merge commit itself is never pushed; the head pin plus
// app.js's base re-check together are what make the squash the tested tree.
export async function mergePr(item, { sha } = {}) {
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
    await promoteBaseline(item).catch(() => {})
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

export async function postIssueComment(item, body) {
  const res = await gh(`/repos/${item.repo}/issues/${item.issue}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  })
  if (!res.ok) throw new Error(`GitHub returned ${res.status} posting a comment`)
}

// ---- issue status sync (UI → GitHub) ----
// Approving the final "Review the work & close" gate closes the issue with a
// summary comment. (GitHub → UI sync lives in store.upsertFromGithub.)

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
export async function prsForCommit(repo, sha) {
  const res = await gh(`/repos/${repo}/commits/${encodeURIComponent(sha)}/pulls`)
  if (!res.ok) return []
  const prs = await res.json().catch(() => [])
  return Array.isArray(prs) ? prs.filter((pr) => pr?.merged_at && pr?.base?.ref === 'main').map((pr) => pr.number) : []
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
      const sha = await getBranchSha(repo, 'main').catch(() => null)
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
