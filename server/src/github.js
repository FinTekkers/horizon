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

function ghHeaders(token) {
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

const PRIORITY_LABEL_COLORS = { Critical: '9C333E', High: 'DFA200', Medium: '2E6CB2', Low: '8C8C8E' }

async function ensurePriorityLabel(repo, token, priority) {
  const name = `priority: ${priority.toLowerCase()}`
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
const PRIORITY_LABEL_RE = /^(?:priority\s*[:/-]?\s*)?(critical|high|medium|low)$/i

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

// Open the PR for a branch a real agent already pushed (the farm's Eng agent
// owns the code; this side owns the PR mechanics).
export async function createPrFromBranch(item, branch) {
  const repo = item.repo
  const repoRes = await gh(`/repos/${repo}`)
  if (!repoRes.ok) throw new Error(`could not read the repository (${repoRes.status})`)
  const base = (await repoRes.json()).default_branch

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

// Accepting the code merges its PR (squash) and removes the work branch.
export async function mergePr(item) {
  const repo = item.repo
  const res = await gh(`/repos/${repo}/pulls/${item.pr}/merge`, {
    method: 'PUT',
    body: JSON.stringify({ merge_method: 'squash' }),
  })
  if (res.ok) {
    // Best-effort branch cleanup; the merge is what matters.
    await gh(`/repos/${repo}/git/refs/${encodeURIComponent(`heads/horizon/${item.id.toLowerCase()}`)}`, {
      method: 'DELETE',
    }).catch(() => {})
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
          : data.message || `GitHub returned ${res.status}`
  throw new Error(message)
}

// ---- deploy: release + dummy workflow ----
// The DevOps step publishes a GitHub Release, which triggers the deploy
// workflow. The workflow itself is self-provisioned: created on the default
// branch the first time a deploy runs (requires the Workflows permission).

const DEPLOY_WORKFLOW_PATH = '.github/workflows/horizon-deploy.yml'
const DEPLOY_WORKFLOW_YML = [
  'name: Horizon Deploy',
  'on:',
  '  release:',
  '    types: [published]',
  '  workflow_dispatch:',
  '',
  'jobs:',
  '  deploy:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - name: Simulate deploy',
  '        run: |',
  '          echo "Horizon dummy deploy pipeline"',
  '          echo "Release: ${GITHUB_REF_NAME}"',
  '          echo "Replace this job with the real deployment."',
  '',
].join('\n')

async function ensureDeployWorkflow(repo) {
  const existing = await gh(`/repos/${repo}/contents/${DEPLOY_WORKFLOW_PATH}`)
  if (existing.ok) return false
  const put = await gh(`/repos/${repo}/contents/${DEPLOY_WORKFLOW_PATH}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: 'Horizon: add dummy deploy workflow (runs on release)',
      content: Buffer.from(DEPLOY_WORKFLOW_YML, 'utf8').toString('base64'),
    }),
  })
  if (!put.ok) {
    throw new Error(`could not add the deploy workflow (${put.status} — check the token has Workflows read/write)`)
  }
  return true
}

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
  const addedWorkflow = await ensureDeployWorkflow(repo)
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
        '_Published by the Horizon DevOps agent — triggers the Horizon Deploy workflow._',
      ].join('\n'),
    }),
  })
  if (!res.ok) {
    throw new Error(`could not publish the release (${res.status} — check the token has Contents read/write)`)
  }
  const release = await res.json()
  return { ...release, addedWorkflow }
}

// Agent step results are posted to the issue so GitHub stays the
// human-readable record of what the bots did.
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

const ACCEPT_GATE_INDEX = 12 // "Accept the code" in the fixed pipeline

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
    return !store.requestChanges(item.id, 'Accept the code', `PR #${prNumber} was closed on GitHub without merging`).error
  }
  return false
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
      // Surface mergeability so the accept gate can offer a one-click
      // conflict-resolution rework (GitHub computes it async; null = unknown).
      const flag = pr.merged || pr.state === 'closed' || pr.mergeable == null ? null : pr.mergeable ? 1 : 0
      const row = db.prepare('SELECT pr_mergeable FROM work_item WHERE id = ?').get(item.id)
      if (row && (row.pr_mergeable ?? null) !== flag) {
        db.prepare("UPDATE work_item SET pr_mergeable = ?, updated_at = datetime('now') WHERE id = ?").run(flag, item.id)
        store.notifyChange()
      }
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
