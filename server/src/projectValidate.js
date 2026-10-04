// HZ-248: 'Validate project' — the onboarding pre-flight, run from Admin.
//
// Six read-only checks, the ones done by hand for FinTekkers on 2026-10-02:
// repo access + push permission, webhook present, check commands green on
// `main`, rules resolving, the deploy target's Dry run (HZ-258), and drift
// between what is deployed and `main`. Each reports pass/fail, a detail and
// its duration; the run is stored (store.recordValidation) and read back
// through GET /api/projects/:id/validation.
//
// Read-only: nothing here deploys, pushes or writes a webhook. GitHub is only
// read (getRepoPermissions, webhooks.inspect, getBranchSha). The check
// commands run in farm/validate.py's scratch worktree under the check-slot
// limiter, never in a deploy target's checkout or ~/.horizon — every target's
// repoDir and ~/.horizon go to it as --forbid roots. The Dry run is
// deployDryRun.runDryRun as-is.
//
// Every check is bounded on its own (deployDryRun.bounded) by
// min(its timeout, what is left of the run cap), and all six start together,
// so one that throws or hangs never stops the others. validateProject()
// never throws.
//
// Every detail goes through scrub() before it is stored or logged.

import { homedir } from 'node:os'
import path from 'node:path'
import { redact } from './caretakerRules.js'
import { DRY_RUN_TIMEOUT_MS } from './config.js'
import { listTargetStatuses } from './deploy.js'
import * as deployDryRun from './deployDryRun.js'
import { findTargetByRepo, listTargets } from './deployTargets.js'
import { resolveRules } from './definitions.js'
import * as github from './github.js'
import * as premerge from './premerge.js'
import { servedRulesFor } from './rulesStore.js'
import { getToken } from './settings.js'
import * as store from './store.js'
import * as webhooks from './webhooks.js'

export const VALIDATION_CHECKS = Object.freeze(['repo_access', 'webhook', 'check_commands', 'rules', 'dry_run', 'drift'])

export const CHECK_TIMEOUT_MS = Object.freeze({
  repo_access: 15_000,
  webhook: 15_000,
  check_commands: 25 * 60_000,
  rules: 5_000,
  dry_run: DRY_RUN_TIMEOUT_MS + 5_000,
  drift: 15_000,
})

export const RUN_CAP_MS = 30 * 60_000

const DETAIL_MAX = 2000
// After a run Node had to kill, farm/validate.py --reap-only removes what it left.
const REAP_TIMEOUT_MS = 60_000
const FARM_DIR = process.env.HORIZON_FARM_DIR || path.resolve(import.meta.dirname, '../../farm')

// The test seam: every external dependency, replaceable one by one (the
// premerge.runner pattern).
export const deps = {
  getRepoPermissions: (repo) => github.getRepoPermissions(repo),
  inspectWebhook: (repo) => webhooks.inspect(repo),
  getBranchSha: (repo, branch) => github.getBranchSha(repo, branch),
  spawn: (args, opts) => premerge.runner.spawn(args, opts),
  checkCommands: (repo) => store.getRepoCheckCommands(repo),
  repoConfig: (repo) => store.getRepoConfig(repo),
  resolveRules: (projectName, repo) => resolveRules(projectName, repo, servedRulesFor(projectName, repo)),
  findTargetByRepo: (repo) => findTargetByRepo(repo),
  listTargets: () => listTargets(),
  targetState: (target) => listTargetStatuses().find((s) => s.key === target.key) ?? null,
  runDryRun: (target) => deployDryRun.runDryRun(target),
  tryBeginDryRun: (key) => deployDryRun.tryBeginDryRun(key),
  endDryRun: (key) => deployDryRun.endDryRun(key),
  recordValidation: (row) => store.recordValidation(row),
}

function storedToken() {
  try {
    return getToken()
  } catch {
    return null
  }
}

// Secrets out, length capped. redact() covers the env secrets and gh*_ token
// shapes; the token may also live in the settings table, and a clone URL can
// carry credentials inline.
export function scrub(text) {
  let out = redact(text, { oneLine: false })
  const token = storedToken()
  if (token && token.length >= 4) out = out.split(token).join('[redacted]')
  out = out.replace(/x-access-token:[^@\s]+@/g, 'x-access-token:[redacted]@')
  out = out.replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1[redacted]@')
  return out.length > DETAIL_MAX ? out.slice(0, DETAIL_MAX - 1) + '…' : out
}

// One validation per project at a time, held in memory only.
const validating = new Set()

export function tryBeginValidation(projectId) {
  if (validating.has(projectId)) return false
  validating.add(projectId)
  return true
}

export function endValidation(projectId) {
  validating.delete(projectId)
}

export function isValidating(projectId) {
  return validating.has(projectId)
}

const pass = (reason) => ({ pass: true, reason })
const fail = (reason) => ({ pass: false, reason })
const short = (sha) => String(sha || '').slice(0, 7)
const errorText = (err) => (err instanceof Error ? err.message : String(err))

// Runs `fn` for every repo of the project; passes only if every repo does.
// The detail names the repo when there is more than one.
async function perRepo(ctx, fn) {
  if (!ctx.repos.length) return fail('no repo connected')
  const results = await Promise.all(
    ctx.repos.map(async (repo) => {
      try {
        return { repo, ...(await fn(repo)) }
      } catch (err) {
        return { repo, ...fail(`errored: ${errorText(err)}`) }
      }
    }),
  )
  const failed = results.filter((r) => !r.pass)
  const shown = failed.length ? failed : results
  const reason = results.length === 1 ? shown[0].reason : shown.map((r) => `${r.repo}: ${r.reason}`).join('; ')
  return { pass: failed.length === 0, reason }
}

async function checkRepoAccess(ctx) {
  return perRepo(ctx, async (repo) => {
    const result = await deps.getRepoPermissions(repo)
    if (!result?.ok) return fail(result?.status ? `GitHub returned ${result.status} for ${repo}` : `GitHub unreachable for ${repo}`)
    if (result.push !== true) return fail(`token lacks push on ${repo}`)
    return pass(`push on ${repo}`)
  })
}

async function checkWebhook(ctx) {
  return perRepo(ctx, async (repo) => {
    const status = await deps.inspectWebhook(repo)
    if (status?.status === 'ok') {
      return pass(`webhook ok on ${repo}${status.lastResponseCode ? ` (last delivery ${status.lastResponseCode})` : ''}`)
    }
    if (status?.httpStatus === 403 || status?.httpStatus === 404) return fail(`token lacks admin:repo_hook read on ${repo}`)
    if (status?.reason === 'secret_not_configured') return fail('GITHUB_WEBHOOK_SECRET is not configured')
    return fail(`webhook ${status?.status ?? 'unknown'}${status?.reason ? ` (${status.reason})` : ''} on ${repo}`)
  })
}

// The roots farm/validate.py must keep its scratch run out of.
function forbiddenRoots() {
  const roots = deps
    .listTargets()
    .map((target) => target.repoDir)
    .filter((dir) => typeof dir === 'string' && dir)
  return [...roots, path.join(homedir(), '.horizon')]
}

function tailOf(text, lines = 20) {
  return String(text || '').trim().split('\n').slice(-lines).join('\n')
}

async function checkCommands(ctx, timeoutMs) {
  return perRepo(ctx, async (repo) => {
    const sha = await ctx.mainSha(repo)
    const args = ['-m', 'farm.validate', repo, ctx.runId, sha, '--timeout-s', String(Math.floor(timeoutMs / 1000))]
    const forbid = forbiddenRoots()
    for (const root of forbid) args.push('--forbid', root)
    const configured = deps.checkCommands(repo)
    if (configured) args.push('--check-commands', JSON.stringify(configured))
    // HZ-304: a repo the owner marked 'no checks' runs nothing and reports
    // the waiver; an unmarked repo with no commands fails by name.
    else if (deps.repoConfig(repo)?.noChecks) args.push('--checks-waiver', store.CHECKS_WAIVER.NO_CHECKS)
    const cwd = path.dirname(FARM_DIR)
    const out = await deps.spawn(args, { cwd, timeoutMs, env: premerge.childEnv(timeoutMs) })
    if (out.timedOut) {
      // Killed before Python could reap: its finally never ran.
      const reapArgs = ['-m', 'farm.validate', repo, ctx.runId, '--reap-only']
      for (const root of forbid) reapArgs.push('--forbid', root)
      Promise.resolve()
        .then(() => deps.spawn(reapArgs, { cwd, timeoutMs: REAP_TIMEOUT_MS, env: premerge.childEnv(REAP_TIMEOUT_MS) }))
        .catch(() => {})
      return fail(`check commands timed out after ${Math.round(timeoutMs / 1000)}s on ${repo}`)
    }
    if (out.error) return fail(`could not start the check run: ${errorText(out.error)}`)
    let parsed = null
    try {
      parsed = JSON.parse(String(out.stdout || '').trim())
    } catch {
      parsed = null
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail(`the check run exited ${out.code} without a result\n${tailOf(out.stderr)}`)
    }
    if (parsed.ok === true && out.code === 0) return pass(`checks passed on main ${short(sha)} of ${repo}: ${parsed.detail || 'ok'}`)
    const tail = parsed.tail ? `\n${tailOf(parsed.tail)}` : ''
    return fail(`${parsed.reason || 'crash'} on main ${short(sha)} of ${repo}: ${parsed.detail || 'no detail'}${tail}`)
  })
}

async function checkRules(ctx) {
  return perRepo(ctx, async (repo) => {
    const parts = await deps.resolveRules(ctx.project.name, repo)
    const text = Array.isArray(parts) ? parts.join('\n') : String(parts ?? '')
    if (!text.trim()) return fail(`no rules resolve for ${repo}`)
    return pass(`rules resolve for ${repo} (${Array.isArray(parts) ? parts.length : 1} part(s), ${text.length} chars)`)
  })
}

async function checkDryRun(ctx) {
  return perRepo(ctx, async (repo) => {
    const target = deps.findTargetByRepo(repo)
    if (!target) return pass('no deploy target')
    if (!deps.tryBeginDryRun(target.key)) return fail(`dry run in progress for ${target.key}`)
    // If bounded()'s timer wins, the key is freed when runDryRun settles, not
    // at the timeout — runDryRun bounds every one of its own checks, so it
    // still frees the key within its own timeout.
    let results
    try {
      results = await deps.runDryRun(target)
    } finally {
      deps.endDryRun(target.key)
    }
    const failed = (results || []).filter((r) => !r.pass)
    if (!results?.length) return fail(`dry run for ${target.key} returned no results`)
    if (failed.length) return fail(`${target.key}: ${failed.map((r) => `${r.check}: ${r.reason}`).join('; ')}`)
    return pass(`all ${results.length} dry-run checks pass for ${target.key}`)
  })
}

async function checkDrift(ctx) {
  return perRepo(ctx, async (repo) => {
    const target = deps.findTargetByRepo(repo)
    if (!target) return pass('no deploy target')
    const state = deps.targetState(target)
    if (!state?.lastCommit) return fail(`${target.key} never deployed`)
    const sha = await ctx.mainSha(repo)
    const deployed = state.lastCommit
    if (deployed === sha || (deployed.length >= 7 && sha.startsWith(deployed))) {
      return pass(`deployed ${state.lastTag} matches main (${short(sha)})`)
    }
    return fail(`deployed ${state.lastTag} (${short(deployed)}) differs from main (${short(sha)})`)
  })
}

const CHECKS = {
  repo_access: checkRepoAccess,
  webhook: checkWebhook,
  check_commands: checkCommands,
  rules: checkRules,
  dry_run: checkDryRun,
  drift: checkDrift,
}

// Runs the six checks and stores the result. Resolves
// { id, projectId, startedAt, finishedAt, pass, checks: [{ check, pass, detail, durationMs }] }
// with checks in VALIDATION_CHECKS order. Never throws.
export async function validateProject(
  project,
  { who = 'unknown', now = Date.now, timeouts = CHECK_TIMEOUT_MS, capMs = RUN_CAP_MS, log = null } = {},
) {
  const startedMs = now()
  const capDeadline = startedMs + capMs
  const shas = new Map()
  const ctx = {
    project,
    repos: (project?.repos ?? []).map((r) => (typeof r === 'string' ? r : r?.repo)).filter(Boolean),
    runId: `v${project?.id}-${startedMs}`,
    // Fetched once per repo, shared by check_commands and drift.
    mainSha: (repo) => {
      if (!shas.has(repo)) shas.set(repo, Promise.resolve().then(() => deps.getBranchSha(repo, 'main')))
      return shas.get(repo)
    },
  }

  const checks = await Promise.all(
    VALIDATION_CHECKS.map(async (check) => {
      const begun = now()
      const timeoutMs = Math.max(0, Math.min(timeouts[check], capDeadline - begun))
      const probe = async () => {
        try {
          return await CHECKS[check](ctx, timeoutMs)
        } catch (err) {
          return fail(`${check} errored: ${errorText(err)}`)
        }
      }
      const result = await deployDryRun.bounded(check, probe, timeoutMs)
      const detail = scrub(result.reason) || (result.pass ? 'pass' : 'fail')
      return { check, pass: result.pass === true, detail, durationMs: Math.max(0, now() - begun) }
    }),
  )

  const outcome = {
    id: null,
    projectId: project?.id ?? null,
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: new Date(now()).toISOString(),
    pass: checks.every((c) => c.pass),
    checks,
  }
  try {
    outcome.id = Number(deps.recordValidation({ ...outcome, who }))
  } catch (err) {
    log?.error?.(`project validation: could not store the result: ${scrub(errorText(err))}`)
  }
  log?.info?.({ projectId: outcome.projectId, pass: outcome.pass, failed: checks.filter((c) => !c.pass).map((c) => c.check) }, 'project validation')
  return outcome
}
