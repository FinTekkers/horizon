#!/usr/bin/env node
// HZ-718: publish scripts/tenant-sites/parvati-site/ as-is to the public
// ParvatiRealEstate/parvati-site repo and serve it on GitHub Pages.
//
//   node scripts/tenant-sites/publish/publish.mjs [--dry-run] [--no-screens] [--out <dir>]
//
// Run as the Parvati account: the token comes from PARVATI_GITHUB_TOKEN and
// nowhere else. Re-runs are safe: an existing repo is reused, an unchanged
// folder makes no commit, and nothing is ever deleted or force-pushed.
// Every commit is written as Parvati Real Estate (lib/identity.mjs), never as
// the token's owner (HZ-725).

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { PublishError, redact } from './lib/errors.mjs'
import { listSiteFiles } from './lib/files.mjs'
import { CREATE_PATHS, OWNER, REPO, REPO_PATH, createGitHub, fetchServed, sameLogin } from './lib/github.mjs'
import { IDENTITY_LINE } from './lib/identity.mjs'
import { buildReport, writeReport } from './lib/report.mjs'
import { captureScreens } from './lib/screens.mjs'

export { PublishError }

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SITE_DIR = path.resolve(HERE, '../parvati-site')
export const DEFAULT_OUT = path.join(HERE, '.out')
export const POLL_MS = 5_000
export const BUDGET_MS = 10 * 60_000

const USAGE = 'usage: node scripts/tenant-sites/publish/publish.mjs [--dry-run] [--no-screens] [--out <dir>]'
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The only place the token is read. No other token variable in the
// environment is looked at, so the publish cannot run as another account by
// accident.
export function readParvatiToken(env) {
  const token = String(env.PARVATI_GITHUB_TOKEN ?? '').trim()
  if (!token) throw new PublishError('PARVATI_GITHUB_TOKEN is not set: export the Parvati account token')
  return token
}

// Path -> { mode, sha } for every file in the remote tree.
async function remoteFiles(gh, head) {
  const commit = await gh.getCommit(head)
  const tree = await gh.getTree(commit.tree.sha)
  if (tree.truncated) throw new PublishError(`${OWNER}/${REPO} has too many files to compare; nothing was written`)
  return new Map(tree.tree.filter((e) => e.type !== 'tree').map((e) => [e.path, { mode: e.mode, sha: e.sha }]))
}

// Everything the plan depends on, read with GETs only.
async function readState(gh) {
  const owner = await gh.getOwner()
  const repo = await gh.getRepo()
  if (!repo && owner?.type === 'User' && !sameLogin(await gh.getTokenLogin(), OWNER)) {
    // POST /user/repos creates under the token's own account, not OWNER.
    throw new PublishError(`${OWNER} is a user account and PARVATI_GITHUB_TOKEN belongs to a different account, so the repo would be created in the wrong place. Nothing was written.`)
  }
  if (repo) {
    if (!sameLogin(repo.full_name, `${OWNER}/${REPO}`)) {
      throw new PublishError(`GitHub answered for a different repo than ${OWNER}/${REPO} (renamed or moved?). Nothing was written.`)
    }
    if (repo.private || (repo.visibility && repo.visibility !== 'public')) {
      throw new PublishError(`${OWNER}/${REPO} exists but is not public. This tool never changes visibility; make it public on GitHub first. Nothing was written.`)
    }
    if (repo.permissions && repo.permissions.admin !== true) {
      throw new PublishError(`PARVATI_GITHUB_TOKEN has no admin rights on ${OWNER}/${REPO}, which GitHub Pages needs. Nothing was written.`)
    }
  }
  const branch = repo?.default_branch || 'main'
  const head = repo ? await gh.getRef(branch) : null
  const remote = head ? await remoteFiles(gh, head) : new Map()
  const pages = repo ? await gh.getPages() : null
  if (pages && (pages.build_type === 'workflow' || (pages.source && (pages.source.branch !== branch || pages.source.path !== '/')))) {
    throw new PublishError(`GitHub Pages for ${OWNER}/${REPO} is not set to build ${branch} / (branch source). This tool does not change it. Nothing was written.`)
  }
  return { ownerType: owner?.type, repo, branch, head, remote, pages }
}

const sameFiles = (files, remote) => files.length === remote.size
  && files.every((f) => remote.get(f.path)?.sha === f.blobSha && remote.get(f.path)?.mode === f.mode)

// The writes a real run would make from this state, in order, plus the remote
// paths the new tree leaves out. Used for --dry-run and printed before a run.
export function planWrites(state, files) {
  const writes = []
  let remote = state.remote
  if (!state.repo) {
    writes.push({ method: 'POST', path: Object.hasOwn(CREATE_PATHS, state.ownerType) ? CREATE_PATHS[state.ownerType] : `(${OWNER} has unexpected account type ${state.ownerType})`, why: `create public repo ${OWNER}/${REPO}` })
  } else if (!state.head) {
    const first = files[0]
    writes.push({ method: 'PUT', path: `${REPO_PATH}/contents/${first.path}`, why: `first file of the empty repo: ${first.path}, as ${IDENTITY_LINE}` })
    remote = new Map([[first.path, { mode: '100644', sha: first.blobSha }]])
  }
  if (!sameFiles(files, remote)) {
    const have = new Set([...remote.values()].map((r) => r.sha))
    for (const f of files) {
      if (have.has(f.blobSha)) continue
      have.add(f.blobSha)
      writes.push({ method: 'POST', path: `${REPO_PATH}/git/blobs`, why: `blob for ${f.path}` })
    }
    writes.push({ method: 'POST', path: `${REPO_PATH}/git/trees`, why: `tree of ${files.length} files` })
    writes.push({ method: 'POST', path: `${REPO_PATH}/git/commits`, why: `commit on top of the current head, as ${IDENTITY_LINE}` })
    writes.push({ method: 'PATCH', path: `${REPO_PATH}/git/refs/heads/${state.branch}`, why: `fast-forward ${state.branch} (force: false)` })
  }
  if (!state.pages) writes.push({ method: 'POST', path: `${REPO_PATH}/pages`, why: `turn on GitHub Pages from ${state.branch} /` })
  const local = new Set(files.map((f) => f.path))
  const dropped = [...state.remote.keys()].filter((p) => !local.has(p)).sort()
  return { writes, dropped }
}

function printPlan(say, { writes, dropped }, dryRun) {
  say(`${dryRun ? 'Dry run: planned' : 'Planned'} writes to ${OWNER}/${REPO}:`)
  if (!writes.length) say('  none: the repo already holds this folder and Pages is on')
  for (const w of writes) say(`  ${w.method} ${w.path}  (${w.why})`)
  for (const p of dropped) say(`  dropped: ${p}  (in the remote head, not in the folder; history keeps it)`)
}

// Waits until Pages has built `sha` and serves the local index.html. The
// build can report "built" before the CDN serves the new bytes, so the byte
// check is retried within the same budget.
async function verifyServed({ gh, fetch, sha, pagesUrl, index, sleep }) {
  let waited = 0
  let built = false
  const url = `${pagesUrl}${pagesUrl.endsWith('/') ? '' : '/'}?publish=${sha.slice(0, 12)}`
  for (;;) {
    if (!built) {
      const build = await gh.latestBuild()
      if (build?.commit === sha && build.status === 'errored') {
        throw new PublishError(`the GitHub Pages build of ${sha} failed: ${build.error?.message || 'no message from GitHub'}`)
      }
      built = build?.commit === sha && build.status === 'built'
    }
    if (built) {
      const served = await fetchServed(fetch, url)
      if (served && served.equals(index.content)) return
    }
    if (waited >= BUDGET_MS) {
      throw new PublishError(built
        ? `GitHub Pages built ${sha} but ${pagesUrl} still did not serve this index.html after ${BUDGET_MS / 60_000} minutes`
        : `GitHub Pages did not finish building ${sha} within ${BUDGET_MS / 60_000} minutes`)
    }
    await sleep(POLL_MS)
    waited += POLL_MS
  }
}

export async function main(argv, {
  env = process.env,
  fetch = globalThis.fetch,
  siteDir = SITE_DIR,
  outDir,
  screens = captureScreens,
  stdout = process.stdout,
  stderr = process.stderr,
  sleep = defaultSleep,
} = {}) {
  let args
  try {
    args = parseArgs({
      args: argv,
      options: { 'dry-run': { type: 'boolean' }, 'no-screens': { type: 'boolean' }, out: { type: 'string' }, help: { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    }).values
  } catch (err) {
    stderr.write(`publish: ${err.message}\n${USAGE}\n`)
    return 2
  }
  if (args.help) {
    stdout.write(`${USAGE}\n`)
    return 0
  }

  let token
  try {
    token = readParvatiToken(env)
  } catch (err) {
    stderr.write(`publish: ${err.message}\n`)
    return 1
  }
  const say = (line) => stdout.write(`${redact(line, [token])}\n`)

  try {
    const files = await listSiteFiles(siteDir)
    const index = files.find((f) => f.path === 'index.html')
    if (!index) throw new PublishError(`${siteDir} has no index.html`)
    const gh = createGitHub({ token, fetch })

    let state = await readState(gh)
    const plan = planWrites(state, files)
    printPlan(say, plan, args['dry-run'])
    if (args['dry-run']) {
      say('Dry run: nothing was written.')
      return 0
    }

    let created = false
    if (!state.repo) {
      const made = await gh.createRepo(state.ownerType)
      if (!sameLogin(made?.owner?.login, OWNER) || !sameLogin(made?.name, REPO)) {
        throw new PublishError(`GitHub created the repo somewhere other than ${OWNER}/${REPO}. Stopped before any other write; check the token's account.`)
      }
      created = true
      say(`Created ${OWNER}/${REPO}.`)
      state = await readState(gh)
    }

    let { head, remote } = state
    const pushed = []
    if (!head) {
      const put = await gh.putFirstFile(files[0], state.branch)
      pushed.push(put.commit)
      head = put.commit.sha
      remote = new Map([[files[0].path, { mode: '100644', sha: put.content.sha }]])
    }

    let committed = false
    if (!sameFiles(files, remote)) {
      const have = new Set([...remote.values()].map((r) => r.sha))
      for (const f of files) {
        if (have.has(f.blobSha)) continue
        const sha = await gh.createBlob(f.content)
        if (sha !== f.blobSha) throw new PublishError(`GitHub stored ${f.path} as ${sha}, expected ${f.blobSha}`)
        have.add(sha)
      }
      const tree = await gh.createTree(files.map((f) => ({ path: f.path, mode: f.mode, type: 'blob', sha: f.blobSha })))
      const commit = await gh.createCommit(`Publish ${REPO} (${files.length} files)`, tree, head)
      await gh.updateRef(state.branch, commit.sha)
      pushed.push(commit)
      head = commit.sha
      committed = true
      say(`Pushed ${head} to ${state.branch}.`)
    } else {
      say(`${state.branch} already holds this folder at ${head}; no commit.`)
    }

    const pages = state.pages ?? await gh.enablePages(state.branch)
    const pagesUrl = pages?.html_url || `https://${OWNER.toLowerCase()}.github.io/${REPO}/`
    say(`Waiting for ${pagesUrl} to serve ${head}...`)
    await verifyServed({ gh, fetch, sha: head, pagesUrl, index, sleep })
    say(`${pagesUrl} serves ${head}.`)

    const out = path.resolve(args.out ?? outDir ?? DEFAULT_OUT)
    const shots = args['no-screens'] ? null : await screens({ url: pagesUrl, outDir: out })
    const report = buildReport({
      owner: OWNER,
      ownerType: state.ownerType,
      repo: REPO,
      visibility: state.repo.visibility || 'public',
      repoUrl: state.repo.html_url || `https://github.com/${OWNER}/${REPO}`,
      pagesUrl,
      branch: state.branch,
      servedSha: head,
      created,
      committed,
      commits: pushed,
      fileCount: files.length,
      screenshots: shots,
      publishedAt: new Date().toISOString(),
    })
    say(`Report: ${await writeReport(out, report, [token])}`)
    return 0
  } catch (err) {
    stderr.write(`publish: ${redact(String(err?.message ?? err), [token])}\n`)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
