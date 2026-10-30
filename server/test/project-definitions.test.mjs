// HZ-542: a project's own definitions files (farm/projects/<slug>/personas.json
// and steps.json) through the real Fastify app, against a temp git checkout
// standing in for the Horizon repo, with a bare "origin" so every save is
// pinned to commit AND push through the HZ-9 path (definitions.js
// commitFarmFile).
//
// The app is built with a real capturing logger, not logger: false, so the
// credential case proves something about log lines.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

const root = fs.mkdtempSync(join(tmpdir(), 'horizon-project-defs-'))
const checkout = join(root, 'checkout')
const farmDir = join(checkout, 'farm')

const ALLOWLIST = '{\n  "version": 1,\n  "tools": [{ "id": "pdfminer", "venv": "/opt/horizon-tools/pdfminer", "commands": ["pdf2txt.py"] }]\n}\n'
fs.mkdirSync(join(farmDir, 'tools'), { recursive: true })
fs.writeFileSync(join(farmDir, 'tools', 'allowlist.json'), ALLOWLIST)
fs.mkdirSync(join(farmDir, 'projects', 'acme', 'personas'), { recursive: true })
fs.writeFileSync(join(farmDir, 'projects', 'acme', 'personas', 'quant.md'), 'Think like a quant.\n')

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
git(root, 'init', '-b', 'main', checkout)
git(checkout, 'config', 'user.email', 'test@example.com')
git(checkout, 'config', 'user.name', 'Test')
git(checkout, 'add', '-A')
git(checkout, 'commit', '-m', 'initial')
const origin = join(root, 'origin.git')
execFileSync('git', ['clone', '--bare', '--quiet', checkout, origin])
git(checkout, 'remote', 'add', 'origin', origin)

process.env.HORIZON_FARM_DIR = farmDir
process.env.HORIZON_DB = join(fs.mkdtempSync(join(tmpdir(), 'horizon-project-defs-db-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const definitions = await import('../src/definitions.js')
const { OPENING_ANCHORS } = await import('../src/substeps.js')
const { PROVIDERS } = await import('../../domain/js/providers.js')

const logs = []
const app = buildApp({ logger: { level: 'trace', stream: { write: (line) => logs.push(line) } } })
const { pin, cookie } = loginFixtureUser(auth, config, { name: 'AP' })
await app.ready()

const ACME = store.createProject('Acme').id
const QUIET = store.createProject('Quiet Co').id
store.setProjectDefinitionsEnabled(QUIET, false, 'test')

const CLAUDE_MODEL = PROVIDERS.find((p) => p.name === 'claude').models[0].id
const QUANT = { id: 'quant', agent: 'eng', label: 'Quant', initials: 'QT', color: '#2E6CB2', model: CLAUDE_MODEL, provider: 'claude', file: 'quant.md' }
const substep = (overrides = {}) => ({
  id: 'golden',
  label: 'Golden cases',
  kind: 'opening',
  anchor: 1,
  output: 'golden_cases',
  applies: { labels: ['pricing'] },
  ...overrides,
})

const put = (slug, file, content, key = pin) =>
  app.inject({ method: 'PUT', url: `/api/projects/${slug}/definitions/${file}`, headers: { 'x-human-key': key, cookie }, payload: { content } })
const get = (url) => app.inject({ method: 'GET', url, headers: { cookie } })
const head = () => git(checkout, 'rev-parse', 'HEAD')
const status = () => git(checkout, 'status', '--porcelain')
const changedFiles = (rev) => git(checkout, 'show', '--name-only', '--format=', rev).split('\n').filter(Boolean)

test('a PIN-authorized PUT of steps.json is one commit touching only that file, pushed, and listed first in its history', async () => {
  const before = head()
  const res = await put('acme', 'steps.json', { substeps: [substep()] })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.pushed, true)
  assert.equal(git(checkout, 'rev-parse', 'HEAD~1'), before)
  assert.deepEqual(changedFiles('HEAD'), ['farm/projects/acme/steps.json'])
  assert.equal(git(checkout, 'log', '-1', '--format=%s'), 'definitions: projects/acme/steps.json edited via UI by AP')
  assert.equal(git(origin, 'rev-parse', 'main'), head())
  assert.deepEqual(JSON.parse(fs.readFileSync(join(farmDir, 'projects', 'acme', 'steps.json'), 'utf8')), { substeps: [substep()] })

  const history = await get('/api/projects/acme/definitions/steps.json/history')
  assert.equal(history.statusCode, 200, history.body)
  const [first] = history.json().history
  assert.equal(first.commit, body.commit)
  assert.equal(first.subject, 'definitions: projects/acme/steps.json edited via UI by AP')
  assert.equal(first.author, 'Horizon')
  assert.ok(!Number.isNaN(Date.parse(first.date)))
})

test('two different PUTs are two scoped commits; the same content again is unchanged and commits nothing', async () => {
  const start = head()
  const one = await put('acme', 'personas.json', { personas: [QUANT] })
  assert.equal(one.statusCode, 200, one.body)
  const two = await put('acme', 'personas.json', { personas: [{ ...QUANT, label: 'Quant desk' }] })
  assert.equal(two.statusCode, 200, two.body)
  assert.equal(git(checkout, 'rev-list', '--count', `${start}..HEAD`), '2')
  assert.deepEqual(changedFiles('HEAD'), ['farm/projects/acme/personas.json'])
  assert.deepEqual(changedFiles('HEAD~1'), ['farm/projects/acme/personas.json'])

  const after = head()
  const again = await put('acme', 'personas.json', { personas: [{ ...QUANT, label: 'Quant desk' }] })
  assert.equal(again.statusCode, 200, again.body)
  assert.deepEqual(again.json(), { ok: true, commit: null, unchanged: true })
  assert.equal(head(), after)

  const history = (await get('/api/projects/acme/definitions/personas.json/history')).json().history
  assert.deepEqual(history.map((h) => h.commit), [two.json().commit, one.json().commit])
})

test('a disallowed anchor is a 400 naming it; HEAD, the tree and the existing file are untouched', async () => {
  const file = join(farmDir, 'projects', 'acme', 'steps.json')
  const existing = fs.readFileSync(file)
  const before = head()
  const res = await put('acme', 'steps.json', { substeps: [substep({ anchor: 5 })] })
  assert.equal(res.statusCode, 400)
  const body = res.json()
  assert.equal(body.error, 'anchor_not_allowed')
  assert.equal(body.anchor, 5)
  assert.match(body.message, /Anchor 5 is not an allowed opening step/)
  assert.equal(head(), before)
  assert.equal(status(), '')
  assert.deepEqual(fs.readFileSync(file), existing)
})

test('GET returns the switch on and off, the allowed opening steps, and each knowledge_doc row as it is stored', async () => {
  const insert = db.prepare(
    `INSERT INTO knowledge_doc (project_id, slug, repo, path, source_sha, status, page_count, section_count, extracted_at)
     VALUES (?, ?, 'acme/docs', ?, ?, ?, ?, ?, datetime('now'))`,
  )
  insert.run(ACME, 'acme-docs__bond-spec-0123456789', 'bond-spec.pdf', 'a'.repeat(40), 'extracted', 42, 17)
  insert.run(ACME, 'acme-docs__broken-9876543210', 'broken.pdf', 'b'.repeat(40), 'failed', 0, 0)

  const on = await get('/api/projects/acme/definitions')
  assert.equal(on.statusCode, 200, on.body)
  const view = on.json()
  assert.equal(view.switch, 'on')
  assert.deepEqual(view.allowedOpeningSteps, [...OPENING_ANCHORS])
  assert.deepEqual(view.toolAllowlist, ['pdfminer'])
  assert.deepEqual(view.files['steps.json'], { exists: true, content: { substeps: [substep()] } })
  assert.equal(view.files['personas.json'].exists, true)
  const rows = db.prepare('SELECT slug, status, page_count, section_count FROM knowledge_doc WHERE project_id = ? ORDER BY slug').all(ACME)
  assert.deepEqual(
    view.knowledge,
    rows.map((r) => ({ slug: r.slug, status: r.status, pageCount: r.page_count, sectionCount: r.section_count })),
  )
  assert.deepEqual(view.knowledge.map((k) => k.status), ['extracted', 'failed'])

  const off = await get('/api/projects/quiet-co/definitions')
  assert.equal(off.statusCode, 200, off.body)
  assert.equal(off.json().switch, 'off')
  assert.deepEqual(off.json().files, { 'personas.json': { exists: false, content: null }, 'steps.json': { exists: false, content: null } })
  assert.deepEqual(off.json().knowledge, [])
})

test('a credential is a 400 with the rules-save body; it reaches no log line, response, file or commit', async () => {
  const token = `ghp_${'A1b2C3d4'.repeat(5)}`
  const before = head()
  logs.length = 0
  const res = await put('acme', 'personas.json', { personas: [{ ...QUANT, label: token }] })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.json(), { error: 'credential_pattern', matches: ['GitHub token'] })
  assert.ok(logs.length > 0, 'the capturing logger saw the request')
  assert.ok(!logs.join('').includes(token))
  assert.ok(!res.body.includes(token))
  assert.equal(head(), before)
  assert.equal(status(), '')
  assert.ok(!fs.readFileSync(join(farmDir, 'projects', 'acme', 'personas.json'), 'utf8').includes(token))
  assert.ok(!git(checkout, 'log', '-p', '--all').includes(token))

  // Same body a rules save gives for the same text.
  const rules = await app.inject({
    method: 'PUT',
    url: '/api/definitions/project/acme',
    headers: { 'x-human-key': pin, cookie },
    payload: { content: `label ${token}\n` },
  })
  assert.deepEqual(rules.json(), res.json())
})

test('a tool missing from allowlist.json is a 400 naming it, and the allow-list is byte-identical', async () => {
  const before = head()
  const res = await put('acme', 'personas.json', { personas: [{ ...QUANT, tools: ['pdfminer', 'ruff'] }] })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, 'tool_not_allowed')
  assert.equal(res.json().tool, 'ruff')
  assert.equal(fs.readFileSync(join(farmDir, 'tools', 'allowlist.json'), 'utf8'), ALLOWLIST)
  assert.equal(head(), before)
  assert.equal(status(), '')
})

test('an unknown slug is a 404 on every route, and a PUT without the PIN is a 401', async () => {
  assert.deepEqual((await get('/api/projects/nope/definitions')).json(), { error: 'unknown_project' })
  assert.equal((await get('/api/projects/nope/definitions')).statusCode, 404)
  assert.equal((await get('/api/projects/nope/definitions/steps.json/history')).statusCode, 404)
  const unknown = await put('nope', 'steps.json', { substeps: [substep()] })
  assert.equal(unknown.statusCode, 404)
  assert.deepEqual(unknown.json(), { error: 'unknown_project' })

  const before = head()
  const noPin = await app.inject({
    method: 'PUT',
    url: '/api/projects/acme/definitions/steps.json',
    headers: { cookie },
    payload: { content: { substeps: [substep({ id: 'other' })] } },
  })
  assert.equal(noPin.statusCode, 401)
  assert.equal(head(), before)
})

test('a file outside the two-file whitelist is 404 unknown_file and nothing is written', async () => {
  const before = head()
  for (const file of ['..%2Fx.json', 'prompts.md', 'personas.json%2F..']) {
    const res = await put('acme', file, { personas: [QUANT] })
    assert.equal(res.statusCode, 404, `${file}: ${res.body}`)
    assert.deepEqual(res.json(), { error: 'unknown_file' })
    const history = await get(`/api/projects/acme/definitions/${file}/history`)
    assert.deepEqual(history.json(), { error: 'unknown_file' })
  }
  assert.equal(head(), before)
  assert.equal(status(), '')
  assert.ok(!fs.existsSync(join(farmDir, 'projects', 'x.json')))
  assert.ok(!fs.existsSync(join(farmDir, 'projects', 'acme', 'prompts.md')))
})

test('a GET writes nothing: the tree stays clean', async () => {
  await get('/api/projects/acme/definitions')
  await get('/api/projects/quiet-co/definitions')
  await get('/api/projects/acme/definitions/personas.json/history')
  assert.equal(status(), '')
  assert.ok(!fs.existsSync(join(farmDir, 'projects', 'quiet-co')))
})

test('with the switch off, a saved personas.json changes no persona overlay or prompt', async () => {
  const project = { name: 'Quiet Co', definitions_enabled: 0 }
  const prompt = definitions.effectivePrompt({ project: 'Quiet Co' })
  fs.mkdirSync(join(farmDir, 'projects', 'quiet-co', 'personas'), { recursive: true })
  fs.writeFileSync(join(farmDir, 'projects', 'quiet-co', 'personas', 'quant.md'), 'Think like a quant.\n')
  git(checkout, 'add', '-A')
  git(checkout, 'commit', '-m', 'quiet-co role file')
  const res = await put('quiet-co', 'personas.json', { personas: [QUANT] })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(definitions.projectPersonaOverlay(project), null)
  assert.equal(definitions.effectivePrompt({ project: 'Quiet Co' }), prompt)
})
