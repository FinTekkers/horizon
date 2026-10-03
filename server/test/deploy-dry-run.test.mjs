// HZ-258: a deploy target's Dry run (deployDryRun.js and
// POST /api/admin/deploy-targets/:key/dry-run). Five read-only checks, each
// pass/fail with a reason; never deploys, restarts or writes.
//
// `systemctl` and `sudo` are PATH stubs that log their argv; `git` is a logging
// wrapper around the real git, so the repo dir's mtimes are real evidence.
// Probes run with a minimal env, so the stubs have their log paths and modes
// baked in rather than read from the environment.

import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { useDeployTargetRows } from './helpers/deployTargetRows.mjs'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

const SECRET_TOKEN = 'SENTINEL-GITHUB-TOKEN-7f3a'
const SECRET_WEBHOOK = 'SENTINEL-WEBHOOK-SECRET-91bc'
const SECRET_URL_TOKEN = 'SENTINEL-URL-TOKEN-c4d2'
const SECRET_STDERR = 'SENTINEL-STDERR-55e1'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-dry-run-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-dry-run-home-'))
process.env.GITHUB_TOKEN = SECRET_TOKEN
process.env.GITHUB_WEBHOOK_SECRET = SECRET_WEBHOOK
delete process.env.FARM_URL

const work = mkdtempSync(join(tmpdir(), 'horizon-dry-run-work-'))
const bin = join(work, 'bin')
const ctrl = join(work, 'ctrl')
const STUB_LOG = join(work, 'stub.log')
const ENV_LOG = join(work, 'env.log')
mkdirSync(bin)
mkdirSync(ctrl)

// ---- PATH stubs ----

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()

function writeStub(name, body) {
  writeFileSync(
    join(bin, name),
    `#!/bin/sh
echo "${name} $*" >> '${STUB_LOG}'
env >> '${ENV_LOG}'
echo '${SECRET_STDERR}' >&2
${body}
`,
    { mode: 0o755 },
  )
}

const mode = (name) => `"$(cat '${join(ctrl, name)}' 2>/dev/null)"`
writeStub(
  'systemctl',
  `case ${mode('systemctl')} in
  fail) echo inactive; exit 3 ;;
  hang) echo $$ > '${join(ctrl, 'systemctl.pid')}'; exec sleep 30 ;;
esac
echo active`,
)
writeStub(
  'sudo',
  `if [ ${mode('sudo')} = fail ]; then echo 'sudo: a password is required' >&2; exit 1; fi
echo 'User test may run the following commands on host:'
echo '    (root) NOPASSWD: /bin/systemctl restart svc-main, /bin/systemctl restart svc-extra'`,
)
writeStub('git', `exec '${REAL_GIT}' "$@"`)
process.env.PATH = `${bin}:${process.env.PATH}`

function setMode(name, value) {
  writeFileSync(join(ctrl, name), value)
}

function stubCalls() {
  if (!existsSync(STUB_LOG)) return []
  return readFileSync(STUB_LOG, 'utf8').split('\n').filter(Boolean).map((line) => line.split(' '))
}

// ---- a real git repo dir, origin carrying a token ----

const repoDir = join(work, 'repo')
mkdirSync(repoDir)
const realGit = (...args) => execFileSync(REAL_GIT, ['-C', repoDir, ...args], { stdio: 'ignore' })
realGit('init', '-q')
writeFileSync(join(repoDir, 'README.md'), 'hello\n')
realGit('add', 'README.md')
realGit('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')
realGit('remote', 'add', 'origin', `https://x-access-token:${SECRET_URL_TOKEN}@github.com/FinTekkers/horizon.git`)

// ---- health servers ----

function healthServer() {
  const server = createServer((req, res) => {
    server.hits += 1
    if (server.mode === 'hang') return
    if (server.mode === 'stall') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"ok":')
      return
    }
    if (server.mode === '500') {
      res.writeHead(500)
      res.end('down')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, itemCount: 3 }))
  })
  server.hits = 0
  server.mode = 'ok'
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

const health = await healthServer()
const otherHealth = await healthServer()
const healthUrl = `http://127.0.0.1:${health.address().port}/api/health`

after(() => {
  for (const server of [health, otherHealth]) {
    server.closeAllConnections()
    server.close()
  }
})

const scriptsDir = await useDeployTargetRows([
  {
    key: 'horizon',
    repo: 'FinTekkers/horizon',
    script: 'stub.sh',
    service: 'svc-main',
    extraServices: ['svc-extra'],
    repoDir,
    stateKey: 'horizon',
    healthUrl,
    healthCheckType: 'json-health',
  },
])
const SENTINEL_RAN = join(work, 'deploy-script-ran')
writeFileSync(join(scriptsDir, 'stub.sh'), `#!/bin/sh\ntouch '${SENTINEL_RAN}'\n`, { mode: 0o755 })
writeFileSync(join(scriptsDir, 'not-executable.sh'), '#!/bin/sh\n', { mode: 0o644 })

const dryRun = await import('../src/deployDryRun.js')
const deployTargets = await import('../src/deployTargets.js')
const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')

const app = buildApp({ logger: false })
const { pin, cookie } = loginFixtureUser(auth, config)
const target = deployTargets.findTargetByKey('horizon')

beforeEach(() => {
  writeFileSync(STUB_LOG, '')
  writeFileSync(ENV_LOG, '')
  setMode('systemctl', 'ok')
  setMode('sudo', 'ok')
  health.mode = 'ok'
  health.hits = 0
  otherHealth.hits = 0
})

const failures = (results) => results.filter((r) => !r.pass).map((r) => r.check)

function assertShape(results) {
  assert.deepEqual(results.map((r) => r.check), [...dryRun.DRY_RUN_CHECKS])
  assert.deepEqual(dryRun.DRY_RUN_CHECKS, ['script', 'repo dir', 'service', 'sudo', 'health'])
  for (const r of results) {
    assert.equal(typeof r.pass, 'boolean')
    assert.equal(typeof r.reason, 'string')
    assert.ok(r.reason.length > 0, `${r.check} has a reason`)
  }
}

// ---- metric 1 ----

test('all green: five results in order, each passing with a reason', async () => {
  const results = await dryRun.runDryRun(target)
  assertShape(results)
  assert.deepEqual(failures(results), [], JSON.stringify(results))
})

const SINGLE_FAULTS = [
  { check: 'script', target: { ...target, script: 'not-executable.sh' }, reason: /script not executable/ },
  { check: 'repo dir', target: { ...target, repoDir: join(work, 'no-such-dir') }, reason: /repo dir missing/ },
  { check: 'service', arrange: () => setMode('systemctl', 'fail'), reason: /service svc-main is not active/ },
  { check: 'sudo', arrange: () => setMode('sudo', 'fail'), reason: /sudo would prompt or is denied/ },
  { check: 'health', arrange: () => (health.mode = '500'), reason: /health returned 500/ },
]

for (const fault of SINGLE_FAULTS) {
  test(`only the ${fault.check} check fails when only its input is broken`, async () => {
    fault.arrange?.()
    const results = await dryRun.runDryRun(fault.target ?? target)
    assertShape(results)
    assert.deepEqual(failures(results), [fault.check], JSON.stringify(results))
    assert.match(results.find((r) => r.check === fault.check).reason, fault.reason)
  })
}

// ---- metric 2 ----

function snapshotTree(dir) {
  const out = {}
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name)
      const st = statSync(path)
      out[path] = `${st.mtimeMs}:${st.size}`
      if (entry.isDirectory()) walk(path)
    }
  }
  walk(dir)
  return out
}

const READ_ONLY = {
  systemctl: (args) => ['is-active', 'status', 'show', 'cat'].includes(args[0]),
  sudo: (args) => args.length === 2 && args[0] === '-n' && args[1] === '-l',
  git: (args) => {
    const rest = args[0] === '-C' ? args.slice(2) : args
    return ['rev-parse', 'status', 'remote'].includes(rest[0])
  },
}

test('never runs the deploy script, calls only read-only verbs, and leaves the repo dir untouched', async () => {
  const before = snapshotTree(repoDir)
  assert.ok(Object.keys(before).some((p) => p.endsWith(join('.git', 'index'))), 'snapshot includes .git/index')
  const results = await dryRun.runDryRun(target)
  assert.deepEqual(failures(results), [])

  assert.equal(existsSync(SENTINEL_RAN), false, 'deploy script was executed')
  const calls = stubCalls()
  assert.deepEqual([...new Set(calls.map(([cmd]) => cmd))].sort(), ['git', 'sudo', 'systemctl'])
  for (const [cmd, ...args] of calls) {
    assert.ok(READ_ONLY[cmd](args), `not read-only: ${cmd} ${args.join(' ')}`)
    assert.ok(!/^(restart|start|stop|reload|enable|disable)$/.test(args[0]), `${cmd} ${args.join(' ')}`)
  }
  for (const [cmd, ...args] of calls.filter(([cmd]) => cmd === 'sudo')) assert.deepEqual(args, ['-n', '-l'], cmd)
  assert.deepEqual(snapshotTree(repoDir), before)
})

test('execProbe refuses anything but the read-only verbs, before spawning', () => {
  for (const [cmd, args] of [
    ['systemctl', ['restart', 'x']],
    ['systemctl', ['start', 'x']],
    ['git', ['status']],
    ['git', ['-C', repoDir, 'status']],
    ['git', ['-C', repoDir, 'remote', 'add', 'x', 'y']],
    ['sudo', ['-l']],
    ['sudo', ['systemctl', 'restart', 'x']],
    ['sh', ['-c', 'true']],
  ]) {
    assert.throws(() => dryRun.execProbe(cmd, args, 1000), /not read-only/, `${cmd} ${args.join(' ')}`)
  }
  assert.deepEqual(stubCalls(), [])
})

// ---- metric 3 / metric 6 / route ----

const tables = () =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map((r) => r.name)

function snapshotDb() {
  const counts = {}
  for (const name of tables()) counts[name] = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n
  return { row: db.prepare("SELECT * FROM deploy_target WHERE key = 'horizon'").get(), counts }
}

const dryRunRequest = (opts = {}) =>
  app.inject({
    method: 'POST',
    url: opts.url ?? '/api/admin/deploy-targets/horizon/dry-run',
    headers: { cookie, ...(opts.pin !== undefined ? { 'x-human-key': opts.pin } : {}) },
    payload: opts.payload ?? {},
  })

test('a Dry run through the route writes nothing to the database (no audit/event rows either)', async () => {
  const before = snapshotDb()
  const res = await dryRunRequest({ pin })
  assert.equal(res.statusCode, 200, res.body)
  const body = JSON.parse(res.body)
  assert.equal(body.key, 'horizon')
  assertShape(body.results)
  const afterRun = snapshotDb()
  assert.deepEqual(afterRun.row, before.row)
  const changed = Object.keys(before.counts).filter((t) => before.counts[t] !== afterRun.counts[t])
  assert.deepEqual(changed, [], `tables whose row counts changed: ${changed.join(', ')}`)
  assert.deepEqual(afterRun.counts, before.counts)
  assert.ok('event' in before.counts, 'the event table was checked too')
})

test('no PIN or a wrong PIN is 401 and no probe runs; an unknown key without a PIN is 401, not 404', async () => {
  for (const [label, opts] of [
    ['no PIN', {}],
    ['wrong PIN', { pin: 'not-the-pin' }],
    ['unknown key, no PIN', { url: '/api/admin/deploy-targets/nope/dry-run' }],
  ]) {
    const res = await dryRunRequest(opts)
    assert.equal(res.statusCode, 401, label)
    assert.equal(JSON.parse(res.body).error, 'human_gate_key_required', label)
  }
  assert.deepEqual(stubCalls(), [])
  assert.equal(health.hits, 0)
  const unknown = await dryRunRequest({ url: '/api/admin/deploy-targets/nope/dry-run', pin })
  assert.equal(unknown.statusCode, 404)
})

test('the request cannot override the row: body fields are 400, a query health URL is ignored', async () => {
  const other = `http://127.0.0.1:${otherHealth.address().port}/`
  for (const field of ['script', 'service', 'repoDir', 'healthUrl']) {
    const value = field === 'healthUrl' ? other : '/tmp/x'
    const res = await dryRunRequest({ pin, payload: { [field]: value } })
    assert.equal(res.statusCode, 400, field)
  }
  assert.deepEqual(stubCalls(), [])
  assert.equal(health.hits, 0)

  const res = await dryRunRequest({ pin, url: `/api/admin/deploy-targets/horizon/dry-run?healthUrl=${encodeURIComponent(other)}` })
  assert.equal(res.statusCode, 200)
  assert.equal(otherHealth.hits, 0)
  assert.equal(health.hits, 1)
})

test('secrets never reach a child env, a reason or the response body', async () => {
  const res = await dryRunRequest({ pin })
  assert.equal(res.statusCode, 200)
  const childEnv = readFileSync(ENV_LOG, 'utf8')
  assert.ok(childEnv.length > 0, 'stubs logged their env')
  for (const secret of [SECRET_TOKEN, SECRET_WEBHOOK]) assert.ok(!childEnv.includes(secret), secret)
  assert.ok(!childEnv.includes('GITHUB_'), 'no GITHUB_* variable reaches a child')
  for (const secret of [SECRET_TOKEN, SECRET_WEBHOOK, SECRET_URL_TOKEN, SECRET_STDERR, pin]) {
    assert.ok(!res.body.includes(secret), `response contains ${secret}`)
  }

  setMode('systemctl', 'fail')
  setMode('sudo', 'fail')
  const failed = await dryRun.runDryRun({ ...target, repo: 'FinTekkers/other' })
  const reasons = failed.map((r) => r.reason).join('\n')
  assert.deepEqual(failures(failed), ['repo dir', 'service', 'sudo'])
  for (const secret of [SECRET_TOKEN, SECRET_WEBHOOK, SECRET_URL_TOKEN, SECRET_STDERR]) {
    assert.ok(!reasons.includes(secret), `reason contains ${secret}`)
  }
})

// ---- metric 4 and hung child probes ----

for (const healthMode of ['hang', 'stall']) {
  test(`a health URL that ${healthMode === 'hang' ? 'never responds' : 'stalls after headers'} fails within the timeout + 1s`, async () => {
    health.mode = healthMode
    const started = Date.now()
    const results = await dryRun.runDryRun(target, { timeoutMs: 500 })
    const elapsed = Date.now() - started
    assert.ok(elapsed <= 1500, `took ${elapsed}ms`)
    assertShape(results)
    assert.deepEqual(failures(results), ['health'], JSON.stringify(results))
    assert.match(results[4].reason, /timed out after 500ms/)
  })
}

test('a hung systemctl is killed at the timeout and holds up no other check', async () => {
  setMode('systemctl', 'hang')
  const started = Date.now()
  const results = await dryRun.runDryRun(target, { timeoutMs: 500 })
  const elapsed = Date.now() - started
  assert.ok(elapsed <= 1500, `took ${elapsed}ms`)
  assertShape(results)
  assert.deepEqual(failures(results), ['service'], JSON.stringify(results))
  assert.match(results[2].reason, /timed out after 500ms/)

  const pid = Number(readFileSync(join(ctrl, 'systemctl.pid'), 'utf8'))
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'hung stub still running')
})

// ---- metric 5 ----

test('the script check goes through the shared containment helper', async () => {
  const calls = []
  const helpers = {
    scriptInsideScriptsDir: (script) => {
      calls.push(script)
      return deployTargets.scriptInsideScriptsDir(script)
    },
    serviceAllowed: deployTargets.serviceAllowed,
    servicesInSudoersText: deployTargets.servicesInSudoersText,
  }
  const results = await dryRun.runDryRun(target, { helpers })
  assert.deepEqual(calls, ['stub.sh'])
  assert.equal(results[0].pass, true)

  const outside = await dryRun.runDryRun({ ...target, script: '../escape.sh' })
  assert.deepEqual(failures(outside), ['script'])
  assert.equal(outside[0].reason, 'script outside infra/host')
})

test('the infra/host containment rule lives only in deployTargets.js', () => {
  const srcDir = join(REPO_ROOT, 'server', 'src')
  const holders = readdirSync(srcDir, { recursive: true })
    .filter((f) => f.endsWith('.js'))
    .filter((f) => readFileSync(join(srcDir, f), 'utf8').includes('realpathSync(scriptsDir())'))
  assert.deepEqual(holders, ['deployTargets.js'])
})

// ---- the real deploy path is unchanged ----

test("server/src/deploy.js, infra/host/ and db.js's deploy_target schema are unchanged from main", (t) => {
  let base
  try {
    base = execFileSync(REAL_GIT, ['-C', REPO_ROOT, 'merge-base', 'HEAD', 'origin/main'], { encoding: 'utf8' }).trim()
  } catch {
    t.skip('no origin/main in this checkout')
    return
  }
  const diff = execFileSync(
    REAL_GIT,
    ['-C', REPO_ROOT, 'diff', '--name-only', base, '--', 'server/src/deploy.js', 'infra/host/'],
    { encoding: 'utf8' },
  )
  assert.equal(diff.trim(), '')
  // Other items add their own tables to db.js; only the deploy_target block
  // (the one the Dry run reads) must stay as it is on main.
  const deployTargetBlock = (source) => {
    const start = source.indexOf('CREATE TABLE IF NOT EXISTS deploy_target')
    return source.slice(start, source.indexOf('`)', start))
  }
  const onMain = execFileSync(REAL_GIT, ['-C', REPO_ROOT, 'show', `${base}:server/src/db.js`], { encoding: 'utf8' })
  const here = readFileSync(join(REPO_ROOT, 'server/src/db.js'), 'utf8')
  assert.ok(onMain.includes('CREATE TABLE IF NOT EXISTS deploy_target'))
  assert.equal(deployTargetBlock(here), deployTargetBlock(onMain))
})

test('checkRunnable keeps its sudoers wording, shared with the Dry run', () => {
  assert.deepEqual(deployTargets.checkRunnable({ ...target, extraServices: ['not-allowed'] }), {
    ok: false,
    reason: 'service not-allowed not in horizon-deploy.sudoers',
  })
  assert.equal(deployTargets.serviceNotAllowedReason('not-allowed'), 'service not-allowed not in horizon-deploy.sudoers')
})
