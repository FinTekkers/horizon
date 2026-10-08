// HZ-263 part 1: deploy targets live in the deploy_target table. Covers the
// one-time seed (equality with the old registry, idempotency, edited and
// human-made rows kept, rollback), the DB-only resolver against the real
// infra/host/ scripts and horizon-deploy.sudoers, read-time validation
// (script confinement, sudoers-derived service allow-list) and the spawn
// path. The boot-level seed is deploy-target-boot.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-target-db-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-deploy-target-db-home-'))
delete process.env.HORIZON_DEPLOY_SCRIPTS_DIR // the real infra/host/

const { db } = await import('../src/db.js')
const deployTargets = await import('../src/deployTargets.js')
const deploy = await import('../src/deploy.js')

// An independent copy of infra/host/deploy-targets.json as it stood before
// HZ-263 — deliberately not derived from SEED_DEPLOY_TARGETS.
const OLD_REGISTRY = [
  {
    key: 'horizon',
    repo: 'FinTekkers/horizon',
    script: 'deploy-horizon.sh',
    service: 'horizon-server',
    repoDir: '/opt/horizon',
    stateKey: 'horizon',
    healthUrl: 'http://127.0.0.1:3001/api/health',
    healthCheckType: 'json-health',
    extraServices: ['horizon-farm'],
  },
  {
    key: 'ui-service',
    repo: 'FinTekkers/ui-service',
    script: 'deploy-ui-service.sh',
    service: 'fintekkers-ui',
    repoDir: '/opt/fintekkers/ui-service',
    stateKey: 'ui-service',
    healthUrl: 'https://www.fintekkers.org/',
    healthCheckType: 'ssr-asset-check',
  },
]

// HZ-353: the code-only seed's row, also an independent copy.
const MDI_ROW = {
  key: 'market-data-inputs',
  repo: 'FinTekkers/market-data-inputs',
  script: 'deploy-market-data-inputs.sh',
  service: '',
  repoDir: '/opt/fintekkers/market-data-inputs',
  stateKey: 'market-data-inputs',
  healthUrl: 'https://github.com/FinTekkers/market-data-inputs',
  healthCheckType: 'deploy-log',
}
const isFirstSeedRow = (key) => OLD_REGISTRY.some((entry) => entry.key === key)

const allRows = () => db.prepare('SELECT * FROM deploy_target ORDER BY key').all()
const marker = () => db.prepare("SELECT value FROM setting WHERE key = 'deploy_target_seed'").get()

function captureConsole(method, fn) {
  const lines = []
  const original = console[method]
  console[method] = (...args) => lines.push(args.join(' '))
  try {
    return { result: fn(), lines }
  } finally {
    console[method] = original
  }
}

function withSpawnStub(fn) {
  const calls = []
  const original = deploy.runner.spawn
  deploy.runner.spawn = (target, tag) => calls.push({ target, tag })
  try {
    fn()
  } finally {
    deploy.runner.spawn = original
  }
  return calls
}

function withScriptsDir(dir, fn) {
  process.env.HORIZON_DEPLOY_SCRIPTS_DIR = dir
  try {
    return fn()
  } finally {
    delete process.env.HORIZON_DEPLOY_SCRIPTS_DIR
  }
}

// Restores the seeded state after a test that rewrites the table.
function reseedFresh() {
  db.prepare('DELETE FROM deploy_target').run()
  db.prepare("DELETE FROM setting WHERE key IN ('deploy_target_seed', 'deploy_target_seed_hz353')").run()
  deployTargets.seedDeployTargets()
  deployTargets.seedCodeOnlyTargets()
}

// ---- metric 1: the migration ----

test('M1: the first-start seed gives one row per old registry entry, equal field by field', () => {
  assert.deepEqual(deployTargets.listTargets().filter((t) => isFirstSeedRow(t.key)), OLD_REGISTRY)
  const raw = allRows().filter((r) => isFirstSeedRow(r.key))
  assert.equal(raw.length, 2)
  for (const entry of OLD_REGISTRY) {
    const row = raw.find((r) => r.key === entry.key)
    assert.equal(row.repo, entry.repo)
    assert.equal(row.script, entry.script)
    assert.equal(row.service, entry.service)
    assert.equal(row.repo_dir, entry.repoDir)
    assert.equal(row.state_key, entry.stateKey)
    assert.equal(row.health_url, entry.healthUrl)
    assert.equal(row.health_check_type, entry.healthCheckType)
    assert.deepEqual(row.extra_services === null ? undefined : JSON.parse(row.extra_services), entry.extraServices)
  }
  assert.equal(marker()?.value, 'done')
})

test('M1: a second run changes nothing; an edited row and a human-made row are kept, nothing deleted', () => {
  const before = { rows: allRows(), marker: marker() }
  assert.deepEqual(deployTargets.seedDeployTargets(), { seeded: 0, skipped: 'already_seeded' })
  assert.deepEqual({ rows: allRows(), marker: marker() }, before)

  try {
    db.prepare("UPDATE deploy_target SET health_url = 'http://127.0.0.1:3001/api/health?edited=1', updated_at = 'edited' WHERE key = 'horizon'").run()
    db.prepare(`INSERT INTO deploy_target (key, repo, script, service, repo_dir, state_key, health_url, health_check_type)
      VALUES ('human', 'Acme/human', 'deploy-horizon.sh', 'horizon-server', '/opt/human', 'human', 'http://127.0.0.1:9/', 'json-health')`).run()
    const edited = allRows()
    // Even with the marker gone, the seed never overwrites or deletes a row.
    db.prepare("DELETE FROM setting WHERE key = 'deploy_target_seed'").run()
    assert.deepEqual(deployTargets.seedDeployTargets(), { seeded: 0 })
    assert.deepEqual(allRows(), edited)
    assert.equal(allRows().length, 4) // the two seeded, market-data-inputs (HZ-353) and the human row
    assert.equal(marker()?.value, 'done')
  } finally {
    reseedFresh()
  }
})

test('guardrail: a failing seed rolls back in one transaction, leaves no partial rows or marker, and logs', () => {
  db.prepare('DELETE FROM deploy_target').run()
  db.prepare("DELETE FROM setting WHERE key = 'deploy_target_seed'").run()
  const broken = [OLD_REGISTRY[0], { ...OLD_REGISTRY[1], script: null }]
  try {
    const { result, lines } = captureConsole('error', () => deployTargets.seedDeployTargets(db, broken))
    assert.equal(result.seeded, 0)
    assert.ok(result.error)
    assert.equal(allRows().length, 0)
    assert.equal(marker(), undefined)
    assert.ok(lines.some((l) => l.includes('deploy_target seed failed, rolled back')), lines.join('\n'))
  } finally {
    reseedFresh()
  }
})

// ---- metric 2: releases resolve only from deploy_target ----

test('M2: both repos resolve every field from deploy_target', () => {
  assert.deepEqual(deploy.resolveTarget('FinTekkers/horizon'), {
    key: 'horizon',
    repo: 'FinTekkers/horizon',
    script: 'deploy-horizon.sh',
    service: 'horizon-server',
    repoDir: '/opt/horizon',
    stateKey: 'horizon',
    healthUrl: 'http://127.0.0.1:3001/api/health',
    healthCheckType: 'json-health',
    extraServices: ['horizon-farm'],
  })
  const ui = deploy.resolveTarget('FinTekkers/ui-service')
  assert.deepEqual(ui, {
    key: 'ui-service',
    repo: 'FinTekkers/ui-service',
    script: 'deploy-ui-service.sh',
    service: 'fintekkers-ui',
    repoDir: '/opt/fintekkers/ui-service',
    stateKey: 'ui-service',
    healthUrl: 'https://www.fintekkers.org/',
    healthCheckType: 'ssr-asset-check',
  })
  assert.equal(deploy.spawnEnv(ui).HORIZON_EXTRA_SERVICES, '')
})

test('M2 / one source, no cache: editing a row changes the next resolve', () => {
  assert.equal(deploy.resolveTarget('FinTekkers/horizon').healthUrl, 'http://127.0.0.1:3001/api/health')
  db.prepare("UPDATE deploy_target SET health_url = 'http://127.0.0.1:3002/api/health' WHERE key = 'horizon'").run()
  try {
    assert.equal(deploy.resolveTarget('FinTekkers/horizon').healthUrl, 'http://127.0.0.1:3002/api/health')
  } finally {
    db.prepare("UPDATE deploy_target SET health_url = 'http://127.0.0.1:3001/api/health' WHERE key = 'horizon'").run()
  }
})

test('one source: server/src has no deploy-targets file override and no registry-file read left', () => {
  const srcDir = join(REPO_ROOT, 'server/src')
  const files = readdirSync(srcDir, { recursive: true }).filter((f) => f.endsWith('.js'))
  assert.ok(files.length > 20, 'walked too few server/src files to mean anything')
  for (const file of files) {
    const code = readFileSync(join(srcDir, file), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    assert.ok(!code.includes('HORIZON_DEPLOY_TARGETS_FILE'), `${file} still reads HORIZON_DEPLOY_TARGETS_FILE`)
    assert.ok(!code.includes('deploy-targets.json'), `${file} still names deploy-targets.json in code`)
  }
})

// ---- metric 4: a repo with no row ----

test('M4: a repo with no row resolves to null and spawns nothing', () => {
  assert.equal(deploy.resolveTarget('FinTekkers/unknown'), null)
  assert.equal(deploy.isDeployableRelease('FinTekkers/unknown', { action: 'published', release: { tag_name: 'v1' } }), false)
  const calls = withSpawnStub(() => deploy.runDeploy('FinTekkers/unknown', 'v1', { info() {} }))
  assert.deepEqual(calls, [])
})

// ---- guardrail: no change to how a resolved deploy runs ----

test('guardrail: the spawn path is <repoRoot>/infra/host/<script>, run without a shell, detached', () => {
  const horizon = deploy.resolveTarget('FinTekkers/horizon')
  assert.equal(deployTargets.scriptPath(horizon), join(REPO_ROOT, 'infra/host/deploy-horizon.sh'))
  const source = deploy.runner.spawn.toString()
  assert.match(source, /spawn\(scriptPath\(target\), \[tag\], \{/)
  assert.match(source, /detached: true/)
  assert.match(source, /stdio: 'ignore'/)
  assert.match(source, /env: spawnEnv\(target\)/)
  assert.doesNotMatch(source, /shell/)
})

test('guardrail: runner.spawn runs the resolved script with the tag and the target env', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'horizon-deploy-target-db-scripts-'))
  const out = join(dir, 'out.txt')
  writeFileSync(join(dir, 'deploy-horizon.sh'), `#!/bin/sh\necho "$1 $HORIZON_SERVICE_NAME $HORIZON_EXTRA_SERVICES" > '${out}'\n`, { mode: 0o755 })
  const target = deploy.resolveTarget('FinTekkers/horizon')
  withScriptsDir(dir, () => deploy.runner.spawn(target, 'v9.9.9'))
  for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50))
  assert.equal(readFileSync(out, 'utf8').trim(), 'v9.9.9 horizon-server horizon-farm')
})

// ---- read-time validation (ruling 1) ----

function stubDirWithSudoers(services) {
  const dir = mkdtempSync(join(tmpdir(), 'horizon-deploy-target-db-stub-'))
  writeFileSync(join(dir, 'horizon-deploy.sudoers'), services.map((s) => `ubuntu ALL=(root) NOPASSWD: /bin/systemctl restart ${s}\n`).join(''))
  return dir
}

function withRow(row, fn) {
  db.prepare(`INSERT INTO deploy_target (key, repo, script, service, repo_dir, state_key, health_url, health_check_type)
    VALUES (@key, @repo, @script, @service, '/tmp/fixture', @key, 'http://stub.invalid/', 'json-health')`).run(row)
  try {
    return fn()
  } finally {
    db.prepare('DELETE FROM deploy_target WHERE key = ?').run(row.key)
  }
}

test('ruling 1: a row whose script symlinks out of infra/host resolves null, spawns nothing, and is logged', () => {
  const dir = stubDirWithSudoers(['stub-service'])
  const outside = mkdtempSync(join(tmpdir(), 'horizon-deploy-target-db-outside-'))
  writeFileSync(join(outside, 'evil.sh'), '#!/bin/sh\n', { mode: 0o755 })
  symlinkSync(join(outside, 'evil.sh'), join(dir, 'link.sh'))
  withRow({ key: 'linked', repo: 'Acme/linked', script: 'link.sh', service: 'stub-service' }, () =>
    withScriptsDir(dir, () => {
      const { result, lines } = captureConsole('warn', () => withSpawnStub(() => {
        assert.equal(deploy.resolveTarget('Acme/linked'), null)
        deploy.runDeploy('Acme/linked', 'v1', { info() {} })
      }))
      assert.deepEqual(result, [])
      assert.ok(lines.some((l) => l.includes('target linked failed validation (script outside infra/host)')), lines.join('\n'))
    }),
  )
})

test('ruling 1: scripts with .., an absolute path or shell metacharacters fail validation', () => {
  const dir = stubDirWithSudoers(['stub-service'])
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'ok.sh'), '#!/bin/sh\n', { mode: 0o755 })
  const base = { key: 'x', repo: 'Acme/x', service: 'stub-service', repoDir: '/tmp/x', stateKey: 'x', healthUrl: 'http://stub.invalid/', healthCheckType: 'json-health' }
  withScriptsDir(dir, () => {
    assert.deepEqual(deployTargets.checkRunnable({ ...base, script: 'ok.sh' }), { ok: true })
    for (const script of ['../ok.sh', 'sub/../ok.sh', join(dir, 'ok.sh'), 'ok.sh;rm', 'ok.sh $(id)', 'missing.sh']) {
      assert.equal(deployTargets.checkRunnable({ ...base, script }).ok, false, script)
    }
  })
})

test('ruling 1: a row whose service is not in horizon-deploy.sudoers resolves null and spawns nothing', () => {
  withRow({ key: 'rogue', repo: 'Acme/rogue', script: 'deploy-horizon.sh', service: 'sshd' }, () => {
    const { result, lines } = captureConsole('warn', () => withSpawnStub(() => {
      assert.equal(deploy.resolveTarget('Acme/rogue'), null)
      deploy.runDeploy('Acme/rogue', 'v1', { info() {} })
    }))
    assert.deepEqual(result, [])
    assert.ok(lines.some((l) => l.includes('target rogue failed validation (service sshd not in horizon-deploy.sudoers)')), lines.join('\n'))
  })
  db.prepare(`UPDATE deploy_target SET extra_services = '["horizon-farm","sshd"]' WHERE key = 'horizon'`).run()
  try {
    const { result } = captureConsole('warn', () => deploy.resolveTarget('FinTekkers/horizon'))
    assert.equal(result, null)
  } finally {
    db.prepare(`UPDATE deploy_target SET extra_services = '["horizon-farm"]' WHERE key = 'horizon'`).run()
  }
})

test('ruling 1: both seeded rows pass validation against the real infra/host/ and sudoers file', () => {
  assert.deepEqual([...deployTargets.allowedServices()].sort(), ['fintekkers-broker', 'fintekkers-ledger', 'fintekkers-price', 'fintekkers-ui', 'fintekkers-valuation', 'horizon-farm', 'horizon-server'])
  for (const target of deployTargets.listTargets()) {
    assert.deepEqual(deployTargets.checkRunnable(target), { ok: true }, target.key)
  }
})

// ---- project rules and runbook ----

test('rules: horizon.md and DEPLOY.md name the deploy_target table, not the JSON file, as the source', () => {
  const rules = readFileSync(join(REPO_ROOT, 'farm/rules/projects/horizon.md'), 'utf8')
  assert.match(rules, /deploy_target/)
  assert.match(rules, /Admin/)
  assert.match(rules, /horizon-deploy\.sudoers/)
  assert.match(rules, /sudoers\s+change\s+still\s+needs\s+a\s+reviewed\s+PR/)
  assert.ok(!rules.includes('deploy-targets.json'), 'horizon.md still names deploy-targets.json')
  const runbook = readFileSync(join(REPO_ROOT, 'infra/host/DEPLOY.md'), 'utf8')
  assert.match(runbook, /deploy_target/)
  assert.ok(!runbook.includes('deploy-targets.json'), 'DEPLOY.md still names deploy-targets.json')
})

// ---- registry-publish: a library target restarts no service ----

const LIBRARY = {
  key: 'ledger-models',
  repo: 'FinTekkers/ledger-models',
  script: 'deploy-ledger-models.sh',
  service: '',
  repoDir: '/opt/fintekkers/ledger-models',
  stateKey: 'ledger-models',
  healthUrl: 'https://github.com/FinTekkers/ledger-models',
  healthCheckType: 'registry-publish',
}

test('registry-publish: a library row with no service is runnable; any other type still needs one', () => {
  assert.deepEqual(deployTargets.checkRunnable(LIBRARY), { ok: true })
  assert.deepEqual(deployTargets.checkRunnable({ ...LIBRARY, healthCheckType: 'grpc-health' }), { ok: false, reason: 'missing service' })
  // A named service on a library row is still held to the sudoers allow-list.
  assert.deepEqual(deployTargets.checkRunnable({ ...LIBRARY, service: 'sshd' }), {
    ok: false,
    reason: 'service sshd not in horizon-deploy.sudoers',
  })
})

test('registry-publish: the Deploy step is told to trust the deploy script, not to load a page', async () => {
  const { deployWaitFor } = await import('../src/deployWait.js')
  db.prepare(`INSERT INTO deploy_target (key, repo, script, service, repo_dir, state_key, health_url, health_check_type)
    VALUES (@key, @repo, @script, @service, @repoDir, @stateKey, @healthUrl, @healthCheckType)`).run(LIBRARY)
  try {
    const wait = deployWaitFor('FinTekkers/ledger-models')
    assert.equal(wait.health_check_type, 'registry-publish')
    assert.equal(Object.hasOwn(wait, 'health_url'), false)
    assert.equal(deploy.resolveTarget('FinTekkers/ledger-models')?.key, 'ledger-models')
  } finally {
    db.prepare('DELETE FROM deploy_target WHERE key = ?').run(LIBRARY.key)
  }
})

// ---- HZ-353: deploy-log, a code-only target with no service ----

const codeOnlyMarker = () => db.prepare("SELECT value FROM setting WHERE key = 'deploy_target_seed_hz353'").get()

// A throwaway in-memory DB with the real schema: db.js's DDL, copied.
async function freshDb() {
  const { default: Database } = await import('better-sqlite3')
  const fresh = new Database(':memory:')
  for (const { sql } of db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all()) {
    fresh.exec(sql)
  }
  return fresh
}

function addRepo(database, repo, noDeploy) {
  const projectId = database.prepare("INSERT INTO project (name) VALUES ('FinTekkers')").run().lastInsertRowid
  database.prepare('INSERT INTO project_repo (project_id, repo, prefix, no_deploy) VALUES (?, ?, ?, ?)').run(projectId, repo, 'MDI', noDeploy)
}
const noDeployOf = (database, repo) => database.prepare('SELECT no_deploy FROM project_repo WHERE repo = ?').get(repo)?.no_deploy

test('deploy-log: a code-only row with no service is runnable and the Deploy step trusts its deploy log', async () => {
  assert.equal(deployTargets.restartsNothing(MDI_ROW), true)
  assert.deepEqual(deployTargets.checkRunnable(MDI_ROW), { ok: true })
  // A named service is still held to the sudoers allow-list.
  assert.deepEqual(deployTargets.checkRunnable({ ...MDI_ROW, service: 'sshd' }), {
    ok: false,
    reason: 'service sshd not in horizon-deploy.sudoers',
  })
  // Pins the rollback note: without deploy-log in the set, the row fails closed.
  assert.deepEqual(deployTargets.checkRunnable({ ...MDI_ROW, healthCheckType: 'some-other-type' }), { ok: false, reason: 'missing service' })
  const { deployWaitFor } = await import('../src/deployWait.js')
  const wait = deployWaitFor('FinTekkers/market-data-inputs')
  assert.equal(wait.health_check_type, 'deploy-log')
  assert.equal(Object.hasOwn(wait, 'health_url'), false)
  assert.equal(deploy.resolveTarget('FinTekkers/market-data-inputs')?.key, 'market-data-inputs')
})

test('M3: the code-only seed reaches a DB that already ran the first seed, clears no_deploy once, and keeps an Admin row', async () => {
  const fresh = await freshDb()
  assert.equal(deployTargets.seedDeployTargets(fresh).seeded, 2)
  addRepo(fresh, 'FinTekkers/market-data-inputs', 1)

  assert.deepEqual(deployTargets.seedCodeOnlyTargets(fresh), { seeded: 1 })
  assert.deepEqual(deployTargets.findTargetByRepo('FinTekkers/market-data-inputs', fresh), MDI_ROW)
  assert.deepEqual(deployTargets.checkRunnable(deployTargets.findTargetByKey('market-data-inputs', fresh)), { ok: true })
  assert.equal(noDeployOf(fresh, 'FinTekkers/market-data-inputs'), 0)

  // A rerun is a no-op, even after the owner sets no_deploy again.
  fresh.prepare("UPDATE project_repo SET no_deploy = 1 WHERE repo = 'FinTekkers/market-data-inputs'").run()
  const rows = fresh.prepare('SELECT * FROM deploy_target ORDER BY key').all()
  assert.deepEqual(deployTargets.seedCodeOnlyTargets(fresh), { seeded: 0, skipped: 'already_seeded' })
  assert.deepEqual(fresh.prepare('SELECT * FROM deploy_target ORDER BY key').all(), rows)
  assert.equal(noDeployOf(fresh, 'FinTekkers/market-data-inputs'), 1)

  // An Admin-made row is never overwritten, and no_deploy stays for the owner's PIN.
  const admin = await freshDb()
  addRepo(admin, 'FinTekkers/market-data-inputs', 1)
  admin.prepare(`INSERT INTO deploy_target (key, repo, script, service, repo_dir, state_key, health_url, health_check_type)
    VALUES ('mdi', 'FinTekkers/market-data-inputs', 'deploy-horizon.sh', 'horizon-server', '/opt/mdi', 'mdi', 'http://127.0.0.1:9/', 'json-health')`).run()
  const before = admin.prepare('SELECT * FROM deploy_target').all()
  assert.deepEqual(deployTargets.seedCodeOnlyTargets(admin), { seeded: 0 })
  assert.deepEqual(admin.prepare('SELECT * FROM deploy_target').all(), before)
  assert.equal(noDeployOf(admin, 'FinTekkers/market-data-inputs'), 1)
  assert.equal(admin.prepare("SELECT value FROM setting WHERE key = 'deploy_target_seed_hz353'").get()?.value, 'done')
})

test('M3: a fresh DB gets both seeds, with no project_repo row for market-data-inputs', async () => {
  const fresh = await freshDb()
  assert.deepEqual(deployTargets.seedDeployTargets(fresh), { seeded: 2 })
  assert.deepEqual(deployTargets.seedCodeOnlyTargets(fresh), { seeded: 1 })
  assert.deepEqual(deployTargets.listTargets(fresh).map((t) => t.key), ['horizon', 'ui-service', 'market-data-inputs'])
  for (const target of deployTargets.listTargets(fresh)) {
    assert.deepEqual(deployTargets.checkRunnable(target), { ok: true }, target.key)
  }
  assert.equal(fresh.prepare('SELECT COUNT(*) AS n FROM project_repo').get().n, 0)
  // This suite's own DB booted the same way.
  assert.deepEqual(deployTargets.findTargetByKey('market-data-inputs'), MDI_ROW)
  assert.equal(codeOnlyMarker()?.value, 'done')
})

test('M3: a code-only row that fails re-validation is kept but leaves no_deploy set, and is logged', async () => {
  const fresh = await freshDb()
  addRepo(fresh, 'Acme/broken', 1)
  const broken = [{ ...MDI_ROW, key: 'broken', repo: 'Acme/broken', stateKey: 'broken', script: 'no-such-script.sh' }]
  const { result, lines } = captureConsole('error', () => deployTargets.seedCodeOnlyTargets(fresh, broken))
  assert.deepEqual(result, { seeded: 1 })
  assert.equal(noDeployOf(fresh, 'Acme/broken'), 1)
  assert.ok(lines.some((l) => l.includes('broken is not runnable (script outside infra/host); no_deploy left set')), lines.join('\n'))
})
