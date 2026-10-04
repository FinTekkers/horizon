// HZ-248: 'Validate project' (projectValidate.js) — six read-only pre-flight
// checks, each pass/fail with a detail and a duration, bounded on their own
// and by a whole-run cap.
//
// Every external dependency is a stub on `deps`. globalThis.fetch throws, so a
// dependency that slips past the stubs fails the test instead of reaching
// GitHub; the one test that drives the real GitHub helpers swaps in a
// recording fetch that only answers the read-only URLs it expects.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { useDeployTargetRows } from './helpers/deployTargetRows.mjs'

const SECRET_TOKEN = 'ghp_SENTINELtokenSENTINELtoken0001'
const SECRET_WEBHOOK = 'SENTINEL-WEBHOOK-SECRET-7d1e'
const SETTINGS_TOKEN = 'SENTINEL-SETTINGS-TOKEN-b9a0'
const URL_TOKEN = 'SENTINEL-URL-TOKEN-4c2f'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-validate-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-validate-home-'))
process.env.GITHUB_TOKEN = SECRET_TOKEN
process.env.GITHUB_WEBHOOK_SECRET = SECRET_WEBHOOK
for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO']) delete process.env[key]

const realFetch = globalThis.fetch
const noNetwork = () => {
  throw new Error('test reached the network: stub this dependency')
}
globalThis.fetch = noNetwork
after(() => {
  globalThis.fetch = realFetch
})

const REPO = 'FinTekkers/horizon'
const MAIN = 'a'.repeat(40)
const OLD = 'b'.repeat(40)

await useDeployTargetRows([
  { key: 'horizon', repo: REPO, repoDir: '/srv/checkouts/horizon', stateKey: 'horizon', service: 'svc-a' },
  { key: 'ui-service', repo: 'FinTekkers/ui-service', repoDir: '/srv/checkouts/ui', stateKey: 'ui-service', service: 'svc-b' },
])

const pv = await import('../src/projectValidate.js')
const store = await import('../src/store.js')
const deploy = await import('../src/deploy.js')
const deployTargets = await import('../src/deployTargets.js')
const webhooks = await import('../src/webhooks.js')
const { setSetting } = await import('../src/settings.js')
const { db } = await import('../src/db.js')

const created = store.createProject('Validated')
const PROJECT = { id: created.id, name: 'Validated', repos: [{ repo: REPO }] }

const ORIGINAL_DEPS = { ...pv.deps }
let spawns
let dryRunTargets

const okSpawn = async (args, opts) => {
  spawns.push({ args, opts })
  return { code: 0, stdout: JSON.stringify({ ok: true, detail: '2 repo check(s) passed' }), stderr: '', timedOut: false }
}

const TARGET = Object.freeze({ key: 'horizon', repo: REPO, repoDir: '/srv/checkouts/horizon' })

function stubAllPassing() {
  Object.assign(pv.deps, {
    getRepoPermissions: async () => ({ ok: true, status: 200, push: true }),
    inspectWebhook: async () => ({ status: 'ok', lastResponseCode: 200, reason: null }),
    getBranchSha: async () => MAIN,
    spawn: okSpawn,
    checkCommands: () => null,
    repoConfig: () => null,
    resolveRules: () => ['# Horizon rules'],
    findTargetByRepo: () => TARGET,
    listTargets: () => [TARGET, { key: 'ui-service', repoDir: '/srv/checkouts/ui' }],
    targetState: () => ({ lastTag: 'v1.4.2', lastCommit: MAIN }),
    runDryRun: async (target) => {
      dryRunTargets.push(target)
      return ['script', 'repo dir', 'service', 'sudo', 'health'].map((check) => ({ check, pass: true, reason: 'ok' }))
    },
    tryBeginDryRun: () => true,
    endDryRun: () => {},
    recordValidation: ORIGINAL_DEPS.recordValidation,
  })
}

beforeEach(() => {
  spawns = []
  dryRunTargets = []
  globalThis.fetch = noNetwork
  stubAllPassing()
})

const never = () => new Promise(() => {})

function assertShape(result) {
  assert.deepEqual(
    result.checks.map((c) => c.check),
    [...pv.VALIDATION_CHECKS],
  )
  assert.equal(new Set(result.checks.map((c) => c.check)).size, 6)
  for (const c of result.checks) {
    assert.equal(typeof c.pass, 'boolean', `${c.check} pass`)
    assert.equal(typeof c.detail, 'string', `${c.check} detail`)
    assert.ok(c.detail.length > 0, `${c.check} has a detail`)
    assert.equal(typeof c.durationMs, 'number', `${c.check} durationMs`)
    assert.ok(c.durationMs >= 0, `${c.check} durationMs >= 0`)
  }
}

const byName = (result, name) => result.checks.find((c) => c.check === name)

// ---- metric 1 ----

test('all green: exactly the six checks, each with a detail and a duration', async () => {
  assert.deepEqual(pv.VALIDATION_CHECKS, ['repo_access', 'webhook', 'check_commands', 'rules', 'dry_run', 'drift'])
  const result = await pv.validateProject(PROJECT, { who: 'Fixture' })
  assertShape(result)
  assert.equal(result.pass, true, JSON.stringify(result.checks))
  assert.ok(result.checks.every((c) => c.pass))
  assert.ok(Number.isInteger(result.id))
})

const FORCED_FAILURES = {
  repo_access: () => (pv.deps.getRepoPermissions = async () => ({ ok: true, status: 200, push: false })),
  webhook: () => (pv.deps.inspectWebhook = async () => ({ status: 'missing', lastResponseCode: null, reason: null })),
  check_commands: () =>
    (pv.deps.spawn = async () => ({
      code: 1,
      stdout: JSON.stringify({ ok: false, reason: 'checks_failed', detail: 'npm test failed', tail: '1 failing' }),
      stderr: '',
    })),
  rules: () => (pv.deps.resolveRules = () => []),
  dry_run: () =>
    (pv.deps.runDryRun = async () => [
      { check: 'script', pass: true, reason: 'ok' },
      { check: 'service', pass: false, reason: 'service svc-a is not active (exit 3)' },
    ]),
  drift: () => (pv.deps.targetState = () => ({ lastTag: 'v1.4.1', lastCommit: OLD })),
}

const EXPECTED_DETAIL = {
  repo_access: /token lacks push on FinTekkers\/horizon/,
  webhook: /webhook missing/,
  check_commands: /checks_failed .*npm test failed/s,
  rules: /no rules resolve/,
  dry_run: /service: service svc-a is not active/,
  drift: /deployed v1\.4\.1 \(bbbbbbb\) differs from main \(aaaaaaa\)/,
}

for (const check of Object.keys(FORCED_FAILURES)) {
  test(`only ${check} fails when only its dependency fails, with a detail`, async () => {
    FORCED_FAILURES[check]()
    const result = await pv.validateProject(PROJECT, { who: 'Fixture' })
    assertShape(result)
    assert.equal(result.pass, false)
    assert.deepEqual(
      result.checks.filter((c) => !c.pass).map((c) => c.check),
      [check],
    )
    assert.match(byName(result, check).detail, EXPECTED_DETAIL[check])
  })
}

test('a check that throws and one that hangs never stop the other four', async () => {
  pv.deps.getRepoPermissions = async () => {
    throw new Error('socket hang up')
  }
  pv.deps.inspectWebhook = never
  const result = await pv.validateProject(PROJECT, { timeouts: { ...pv.CHECK_TIMEOUT_MS, webhook: 50 } })
  assertShape(result)
  assert.match(byName(result, 'repo_access').detail, /socket hang up/)
  assert.equal(byName(result, 'repo_access').pass, false)
  const hung = byName(result, 'webhook')
  assert.equal(hung.pass, false)
  assert.match(hung.detail, /timed out/)
  assert.ok(hung.durationMs >= 50, `hung check recorded ${hung.durationMs}ms`)
  for (const name of ['check_commands', 'rules', 'dry_run', 'drift']) assert.equal(byName(result, name).pass, true, name)
})

test('with every check hung, the run still resolves by the cap', async () => {
  for (const name of ['getRepoPermissions', 'inspectWebhook', 'getBranchSha', 'runDryRun']) pv.deps[name] = never
  pv.deps.resolveRules = never
  pv.deps.targetState = () => ({ lastTag: 'v1', lastCommit: OLD })
  const started = Date.now()
  const result = await pv.validateProject(PROJECT, { capMs: 150 })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 150 + 1500, `took ${elapsed}ms`)
  assertShape(result)
  assert.ok(result.checks.every((c) => !c.pass && /timed out/.test(c.detail)), JSON.stringify(result.checks))
})

// ---- metric 2 (Node half): the scratch run is kept out of every checkout ----

test('check commands get --forbid for every deploy checkout and ~/.horizon, bounded by the cap left', async () => {
  pv.deps.checkCommands = () => ({ install: null, test: 'npm test', lint: null, e2e: null })
  await pv.validateProject(PROJECT, { capMs: 10_000, timeouts: { ...pv.CHECK_TIMEOUT_MS, check_commands: 10 ** 9 } })
  assert.equal(spawns.length, 1)
  const { args, opts } = spawns[0]
  assert.deepEqual(args.slice(0, 5), ['-m', 'farm.validate', REPO, `v${PROJECT.id}-${args[3].split('-')[1]}`, MAIN])
  const forbid = args.flatMap((arg, i) => (args[i - 1] === '--forbid' ? [arg] : []))
  assert.deepEqual(forbid.sort(), ['/srv/checkouts/horizon', '/srv/checkouts/ui', join(homedir(), '.horizon')].sort())
  assert.equal(args[args.indexOf('--check-commands') + 1], JSON.stringify({ install: null, test: 'npm test', lint: null, e2e: null }))
  assert.ok(opts.timeoutMs <= 10_000, `spawn timeout ${opts.timeoutMs} exceeds the cap left`)
  assert.equal(opts.env.GITHUB_TOKEN, undefined)
  assert.equal(opts.env.FARM_CHECK_TIMEOUT_S, String(Math.floor(opts.timeoutMs / 1000)))
})

// HZ-304: the existing check_commands check, not a second path, carries the
// owner's 'no checks' mark to farm/validate.py. Commands win over the mark.
test("a repo marked 'no checks' with no commands runs check_commands with --checks-waiver no_checks", async () => {
  pv.deps.repoConfig = () => ({ checks: null, noChecks: true, noDeploy: false, enforcedSince: null })
  pv.deps.spawn = async (args, opts) => {
    spawns.push({ args, opts })
    const detail = "checks waived for this repo: marked 'no checks' in Admin"
    return { code: 0, stdout: JSON.stringify({ ok: true, detail }), stderr: '', timedOut: false }
  }
  const result = await pv.validateProject(PROJECT, { capMs: 10_000, timeouts: { ...pv.CHECK_TIMEOUT_MS, check_commands: 10 ** 9 } })
  assert.equal(spawns.length, 1)
  const { args } = spawns[0]
  assert.deepEqual(args.slice(args.indexOf('--checks-waiver'), args.indexOf('--checks-waiver') + 2), ['--checks-waiver', 'no_checks'])
  assert.equal(args.includes('--check-commands'), false)
  assert.match(byName(result, 'check_commands').detail, /checks waived for this repo: marked 'no checks' in Admin/)
  assert.deepEqual(result.checks.map((c) => c.check), [...pv.VALIDATION_CHECKS], 'still the same six checks')

  spawns = []
  pv.deps.checkCommands = () => ({ install: null, test: 'npm test', lint: null, e2e: null })
  await pv.validateProject(PROJECT, { capMs: 10_000, timeouts: { ...pv.CHECK_TIMEOUT_MS, check_commands: 10 ** 9 } })
  assert.equal(spawns[0].args.includes('--checks-waiver'), false, 'configured commands win over the mark')
})

test('a check run Node had to kill is followed by --reap-only with the same forbid roots', async () => {
  pv.deps.spawn = async (args, opts) => {
    spawns.push({ args, opts })
    return args.includes('--reap-only') ? { code: 0, stdout: '{"ok":true}', stderr: '' } : { code: null, stdout: '', stderr: '', timedOut: true }
  }
  const result = await pv.validateProject(PROJECT)
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(byName(result, 'check_commands').detail, /timed out/)
  assert.equal(spawns.length, 2)
  const [run, reap] = spawns
  assert.deepEqual(reap.args.slice(0, 5), ['-m', 'farm.validate', REPO, run.args[3], '--reap-only'])
  const forbidOf = (a) => a.flatMap((arg, i) => (a[i - 1] === '--forbid' ? [arg] : []))
  assert.deepEqual(forbidOf(reap.args), forbidOf(run.args))
})

// ---- guardrails ----

test('G5: the Dry run is called as-is on the stored target row', async () => {
  pv.deps.findTargetByRepo = ORIGINAL_DEPS.findTargetByRepo
  const keys = []
  pv.deps.tryBeginDryRun = (key) => keys.push(['begin', key]) && true
  pv.deps.endDryRun = (key) => keys.push(['end', key])
  await pv.validateProject(PROJECT)
  assert.equal(dryRunTargets.length, 1)
  assert.deepEqual(dryRunTargets[0], deployTargets.findTargetByRepo(REPO))
  assert.deepEqual(keys, [
    ['begin', 'horizon'],
    ['end', 'horizon'],
  ])
})

test('G1: a full run with the real GitHub helpers only ever GETs, and never deploys', async () => {
  for (const name of ['getRepoPermissions', 'inspectWebhook', 'getBranchSha', 'targetState']) pv.deps[name] = ORIGINAL_DEPS[name]
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url)
    calls.push({ href, method: options.method ?? 'GET' })
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (href.endsWith(`/repos/${REPO}`)) return json({ permissions: { push: true } })
    if (href.includes(`/repos/${REPO}/hooks`)) {
      return json([{ id: 1, active: true, events: webhooks.HOOK_EVENTS, config: { url: webhooks.webhookUrl(), content_type: 'json' }, last_response: { code: 200 } }])
    }
    if (href.includes(`/repos/${REPO}/git/ref/`)) return json({ object: { sha: MAIN } })
    throw new Error(`unexpected request ${href}`)
  }
  const realDeploySpawn = deploy.runner.spawn
  let deploys = 0
  deploy.runner.spawn = () => deploys++
  try {
    const result = await pv.validateProject(PROJECT)
    assert.equal(byName(result, 'repo_access').pass, true, byName(result, 'repo_access').detail)
    assert.equal(byName(result, 'webhook').pass, true, byName(result, 'webhook').detail)
  } finally {
    deploy.runner.spawn = realDeploySpawn
  }
  assert.ok(calls.length >= 3, JSON.stringify(calls))
  assert.deepEqual(
    calls.filter((c) => c.method !== 'GET'),
    [],
  )
  assert.equal(deploys, 0)
})

test('G6: secrets are scrubbed from details, the stored row and the log', async () => {
  setSetting('github_token', SETTINGS_TOKEN)
  const leaky = `token ${SECRET_TOKEN} secret ${SECRET_WEBHOOK} settings ${SETTINGS_TOKEN} url https://x-access-token:${URL_TOKEN}@github.com/x.git`
  try {
    pv.deps.getRepoPermissions = async () => {
      throw new Error(leaky)
    }
    pv.deps.spawn = async () => ({ code: 1, stdout: 'not json', stderr: `Traceback\n${leaky}` })
    pv.deps.runDryRun = async () => [{ check: 'health', pass: false, reason: leaky }]
    pv.deps.inspectWebhook = async () => ({ status: 'error', reason: leaky })
    const lines = []
    const log = { info: (...args) => lines.push(JSON.stringify(args)), error: (...args) => lines.push(JSON.stringify(args)) }
    pv.deps.recordValidation = () => {
      throw new Error(`db locked ${leaky}`)
    }
    const failedStore = await pv.validateProject(PROJECT, { log })
    pv.deps.recordValidation = ORIGINAL_DEPS.recordValidation
    const result = await pv.validateProject(PROJECT, { log })

    const row = db.prepare('SELECT checks_json FROM project_validation WHERE id = ?').get(result.id)
    const surfaces = { result: JSON.stringify([result, failedStore]), stored: row.checks_json, log: lines.join('\n') }
    assert.ok(lines.some((l) => l.includes('could not store')), 'the store failure was logged')
    for (const [where, text] of Object.entries(surfaces)) {
      for (const secret of [SECRET_TOKEN, SECRET_WEBHOOK, SETTINGS_TOKEN, URL_TOKEN]) {
        assert.ok(!text.includes(secret), `${where} leaked ${secret}`)
      }
    }
    assert.match(row.checks_json, /\[redacted\]/)
  } finally {
    setSetting('github_token', '')
  }
})

test('G4: the deploy_target table schema is unchanged', () => {
  const columns = db.prepare('PRAGMA table_info(deploy_target)').all().map((c) => c.name)
  assert.deepEqual(columns, [
    'key',
    'repo',
    'script',
    'service',
    'repo_dir',
    'state_key',
    'health_url',
    'health_check_type',
    'extra_services',
    'created_at',
    'updated_at',
  ])
})
