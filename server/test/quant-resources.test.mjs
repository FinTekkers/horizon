// HZ-972 metrics 4 and 5, guardrails 1 and 2: FinTekkers' quant resource
// registry, farm/projects/fintekkers/quant_resources.json.
//
// - It validates against domain/quantResources.schema.json and the loader's
//   own rules, lists the resources the metric names, and both quant role files
//   point to it. Each refusal rule is shown refusing.
// - At the first gate, a golden case whose doc is not a registry entry's
//   knowledge source is refused through the real approve route; a project
//   with no registry (Horizon) is unchanged.
// - The downloaded papers are exactly the knowledge sources personas.json names.
// - No third-party code or paper is tracked in this repo.
// - On the box, the registry matches the store: RESOURCES.json,
//   papers/MANIFEST.md, papers/SHA256SUMS.txt and the PDFs themselves. With no
//   store the drift test skips — unless HORIZON_REQUIRE_QUANT_STORE=1, when it
//   fails.
//
// Runs against the REAL farm tree (no HORIZON_FARM_DIR override), so the
// committed files are what is read.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

globalThis.fetch = async () => {
  throw new Error('quant-resources test: no network')
}
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-hz972-registry-')), 'test.db')
delete process.env.HORIZON_FARM_DIR
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO', 'WA_NOTIFY_ENABLED']) delete process.env[key]
process.env.MOCK_STEP_LATENCY_MS = String(60 * 60 * 1000)

const REPO_ROOT = join(import.meta.dirname, '../..')
const REGISTRY_PATH = join(REPO_ROOT, 'farm/projects/fintekkers/quant_resources.json')
const REGISTRY = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'))
const SCHEMA = JSON.parse(readFileSync(join(REPO_ROOT, 'domain/quantResources.schema.json'), 'utf8'))

const { validate } = await import('../../domain/validate.mjs')
const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const quant = await import('../src/quantResources.js')
const { knowledgeSlug } = await import('../src/knowledgeDocs.js')
const { DEFAULT_DIR: KNOWLEDGE_PDF_DIR } = await import('../../scripts/knowledge-pdfs.mjs')
const { requiredStepIndex, stepKeyAt } = await import('../../domain/js/lifecycle.js')

const byId = Object.fromEntries(REGISTRY.resources.map((r) => [r.id, r]))

// ---- metric 4: the registry, its schema and the role files ----

test('the registry passes the schema and the loader, and loads for FinTekkers', () => {
  assert.deepEqual(validate(SCHEMA, REGISTRY), [])
  assert.deepEqual(quant.validateQuantResources(REGISTRY), [])
  const loaded = quant.loadQuantResources('FinTekkers')
  assert.deepEqual(loaded.errors, [])
  assert.equal(loaded.resources.length, REGISTRY.resources.length)
  assert.deepEqual(loaded.readers, ['quant', 'rust_quant'])
})

test('it lists QuantLib source and venv, the reference scripts, the catalog, the four standards and the official data', () => {
  const source = byId['quantlib-source']
  assert.equal(source.kind, 'library')
  assert.equal(source.pinned.tag, 'v1.44')
  assert.match(source.pinned.sha, /^[0-9a-f]{40}$/)
  assert.equal(source.location, '/opt/quant-resources/libs/lballabio_QuantLib')
  const venv = byId['quantlib-venv']
  assert.equal(venv.kind, 'venv')
  assert.equal(venv.pinned.tag, 'QuantLib==1.44')
  assert.equal(venv.location, '/opt/quant-resources/venv/bin/python')
  assert.ok(!REGISTRY.resources.some((r) => r.location.startsWith('/tmp')), 'nothing points at /tmp')
  assert.match(byId['vs-bond-quantlib-reference'].location, /FinTekkers\/valuation-service\/.*tests\/e2e\/bond_quantlib_reference\.py$/)
  assert.match(byId['vs-tips-pnl-quantlib-reference'].location, /FinTekkers\/valuation-service\/.*tests\/e2e\/tips_pnl_quantlib_reference\.py$/)
  assert.match(byId['lm-measures-catalog'].location, /FinTekkers\/ledger-models\/.*ledger-models-protos\/catalog\/measures\.json$/)
  assert.match(byId['lm-adrs'].location, /FinTekkers\/ledger-models\//)
  for (const id of ['cfr-356-app-b', 'sifma-standard-formulas', 'sifma-holiday-schedule', 'icma-rule-251', 'bls-cpi']) {
    assert.equal(byId[id]?.kind, 'standard', id)
  }
  for (const id of ['treasurydirect-tips-cpi', 'fiscaldata', 'nyfed-soma']) assert.equal(byId[id]?.kind, 'data', id)
  assert.match(byId['treasurydirect-tips-cpi'].notes, /CPI_20251126\.pdf.*325\.604/)
  for (const name of ['bond-maths', 'day-counts', 'settlement', 'tips']) {
    assert.deepEqual(byId[`fk-${name}`].library, { repo: 'FinTekkers/horizon', path: `farm/projects/fintekkers/knowledge/${name}.pdf` })
  }
  assert.equal(REGISTRY.store.repo, 'FinTekkers/quant-library')
})

test('licences: GPL, AGPL, non-commercial and unlicensed code is read-and-run only; permissive code is not', () => {
  const use = (name) => REGISTRY.resources.find((r) => r.kind === 'library' && r.name === name).use
  for (const name of ['FinancePy', 'PyFENG', 'QuantLib-Risks-Py', 'QuantLib-Risks-Cpp', 'rateslib', 'py_lets_be_rational']) assert.equal(use(name), 'read_and_run_only', name)
  for (const name of ['QuantLib', 'ORE (Open Source Risk Engine)', 'Strata', 'finmath-lib', 'QLNet']) assert.equal(use(name), 'read_and_copy', name)
})

test('both quant role files point to the registry and stay under the role-file cap', () => {
  for (const file of ['eng_rust_quant.md', 'qa_quant.md']) {
    const text = readFileSync(join(REPO_ROOT, 'farm/roles/personas', file), 'utf8')
    assert.match(text, /farm\/projects\/fintekkers\/quant_resources\.json/, file)
    assert.match(text, /read_and_run_only/, file)
    assert.match(text, /never copied into a FinTekkers repo/, file)
    assert.ok(Buffer.byteLength(text) <= 8192, `${file} is over 8192 bytes`)
  }
})

// ---- metric 4: each refusal rule refuses ----

const MINIMAL = () => ({
  version: 1,
  store: { repo: 'FinTekkers/quant-library', path: '/opt/quant-resources', sha: 'a'.repeat(40) },
  readers: ['quant'],
  resources: [
    { id: 'lib-a', name: 'A', kind: 'library', location: '/opt/quant-resources/libs/a', pinned: { tag: 'v1', sha: 'b'.repeat(40) }, licence: 'BSD', use: 'read_and_copy', status: 'available', authoritative_for: ['x'] },
    { id: 'paper-a', name: 'P', kind: 'paper', location: 'https://example.org/p.pdf', licence: 'author', use: 'read_and_run_only', status: 'downloaded', authoritative_for: ['y'], sha256: 'c'.repeat(64), library: { repo: 'FinTekkers/quant-library', path: 'papers/p.pdf' } },
    { id: 'doc-a', name: 'D', kind: 'knowledge_doc', location: 'd.md', licence: 'own', use: 'read_and_copy', status: 'available', authoritative_for: ['z'], library: { repo: 'FinTekkers/horizon', path: 'd.pdf' } },
  ],
})
const allErrors = (raw) => quant.validateQuantResources(raw)

test('the minimal registry the refusals start from is valid', () => {
  assert.deepEqual(allErrors(MINIMAL()), [])
})

const REFUSALS = [
  ['a downloaded paper with no sha256', (r) => delete r.resources[1].sha256, /sha256/],
  ['a downloaded paper with no library', (r) => delete r.resources[1].library, /library/],
  ['a knowledge_doc with no library', (r) => delete r.resources[2].library, /library/],
  ['an unknown kind', (r) => (r.resources[0].kind = 'blog'), /kind/],
  ['an unknown status', (r) => (r.resources[0].status = 'maybe'), /status/],
  ['a pinned sha that is not 40 hex', (r) => (r.resources[0].pinned.sha = 'Z'.repeat(40)), /pinned\.sha/],
  ['a sha256 that is not 64 hex', (r) => (r.resources[1].sha256 = 'g'.repeat(64)), /sha256/],
  ['a duplicate id', (r) => (r.resources[2].id = 'lib-a'), /duplicate id/],
  ['a store sha that is not 40 hex', (r) => (r.store.sha = 'main'.padEnd(40, 'x')), /store\.sha/],
  ['a library that is not a PDF source', (r) => (r.resources[1].library.path = '../p.pdf'), /library/],
  ['an unknown key', (r) => (r.resources[0].homepage = 'x'), /homepage/],
]
for (const [name, mutate, field] of REFUSALS) {
  test(`refuses ${name}, naming the field`, () => {
    const raw = MINIMAL()
    mutate(raw)
    const errors = allErrors(raw)
    assert.ok(errors.length > 0, `${name} was accepted`)
    assert.match(errors.join('\n'), field)
  })
}

test('a project with no registry gets { resources: null, errors: [] } and no citation rule', () => {
  assert.deepEqual(quant.loadQuantResources('Horizon'), { resources: null, readers: [], errors: [] })
  assert.equal(quant.registryDocSlugs('Horizon'), null)
})

test('a registry that does not parse or validate fails closed: every citation is refused', () => {
  const read = quant.deps.readFile
  try {
    quant.deps.readFile = () => '{ not json'
    assert.match(quant.loadQuantResources('FinTekkers').errors[0], /quant_resources\.json/)
    assert.deepEqual(quant.registryDocSlugs('FinTekkers'), new Set())
    quant.deps.readFile = () => JSON.stringify({ ...MINIMAL(), version: 2 })
    assert.ok(quant.loadQuantResources('FinTekkers').errors.length > 0)
    assert.deepEqual(quant.registryDocSlugs('FinTekkers'), new Set())
  } finally {
    quant.deps.readFile = read
  }
})

// ---- metric 5: the papers are one set ----

test('the downloaded papers are exactly the quant-library knowledge sources in personas.json; the rest have no library', () => {
  const personas = JSON.parse(readFileSync(join(REPO_ROOT, 'farm/projects/fintekkers/personas.json'), 'utf8'))
  const sources = personas.personas.flatMap((p) => p.knowledge ?? []).filter((k) => k.repo === 'FinTekkers/quant-library')
  const papers = REGISTRY.resources.filter((r) => r.kind === 'paper')
  assert.deepEqual(
    papers.filter((r) => r.status === 'downloaded').map((r) => r.library),
    sources,
  )
  for (const paper of papers.filter((r) => r.status !== 'downloaded')) assert.equal(paper.library, undefined, paper.id)
  assert.equal(byId['paper-okane-2003-valuation-of-cds'].status, 'unavailable')
  assert.equal(byId['paper-lyashenko-2019-in-arrears-term-rates-risk'].status, 'paywalled')
})

// ---- guardrail 1: no third-party code or paper in Horizon ----

test('no submodule, no libs/ tree, and no PDF but the ones scripts/knowledge-pdfs.mjs renders', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
  assert.ok(tracked.length > 100, 'git ls-files returned almost nothing')
  assert.deepEqual(tracked.filter((f) => f === '.gitmodules' || f.endsWith('/.gitmodules')), [])
  assert.deepEqual(tracked.filter((f) => f.startsWith('libs/') || f.includes('/quant-resources/')), [])
  const rendered = readdirSync(KNOWLEDGE_PDF_DIR)
    .filter((n) => n.endsWith('.md'))
    .map((n) => relative(REPO_ROOT, join(KNOWLEDGE_PDF_DIR, n.replace(/\.md$/, '.pdf'))))
  assert.ok(rendered.length >= 4)
  assert.deepEqual(tracked.filter((f) => f.toLowerCase().endsWith('.pdf')).sort(), rendered.sort())
  const gitlinks = execFileSync('git', ['ls-files', '-s'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n').filter((l) => l.startsWith('160000 '))
  assert.deepEqual(gitlinks, [], 'no gitlink (submodule) entries')
})

// ---- metric 4: the refusal at the first gate, through the approve route ----

const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)
await app.ready()
store.purgeDemoItems()

const GATE = requiredStepIndex('Approve & prioritize this work')
const SNAPSHOT = JSON.stringify([
  { id: 'quant-golden-cases', label: 'Quant golden cases', kind: 'opening', anchor: 1, persona: 'quant', output: 'golden_cases', applies: { repos: ['FinTekkers/valuation-service'], labels: ['quant'] } },
])
const BOND_MATHS = knowledgeSlug('FinTekkers/horizon', 'farm/projects/fintekkers/knowledge/bond-maths.pdf')
const projectOf = (name) =>
  db.prepare('SELECT id FROM project WHERE name = ?').get(name)?.id ??
  Number(db.prepare('INSERT INTO project (name, enabled, definitions_enabled) VALUES (?, 1, 1)').run(name).lastInsertRowid)
const fintekkers = projectOf('FinTekkers')
const horizon = projectOf('Horizon')
db.prepare('UPDATE project SET definitions_enabled = 1 WHERE id IN (?, ?)').run(fintekkers, horizon)
const indexDoc = (projectId, slug, sections) =>
  db
    .prepare("INSERT INTO knowledge_doc (project_id, slug, repo, path, source_sha, status, sections_json, extracted_at) VALUES (?, ?, 'FinTekkers/docs', 'x.pdf', 'abc', 'extracted', ?, datetime('now'))")
    .run(projectId, slug, JSON.stringify(sections.map((id, i) => ({ id, title: `${i + 1} ${id}`, page: i + 1 }))))
indexDoc(fintekkers, BOND_MATHS, ['modified-duration', 'yield-to-maturity'])
// Indexed in both projects but in no registry: only the registry can refuse it.
indexDoc(fintekkers, 'unknown-doc', ['x'])
indexDoc(horizon, 'unknown-doc', ['x'])

const CASE = { id: 'md', inputs: { settlement: '2026-11-30' }, measure: 'modified_duration', expected: 2.637, tolerance: { abs: 0.0005 }, source: `${BOND_MATHS}#modified-duration` }
const UNREGISTERED = { ...CASE, id: 'stray', source: 'unknown-doc#x' }
function seed(id, projectId, cases) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id, substeps_json, metric) VALUES (?, ?, 'High', ?, 'change', ?, ?, '1. Values match.')").run(id, `Item ${id}`, GATE, projectId, SNAPSHOT)
  db.prepare("INSERT INTO step_run (item_id, step_index, substep_id, attempt, agent, status, artifact) VALUES (?, 1, 'quant-golden-cases', 1, 'QA', 'done', ?)").run(
    id,
    '```json golden-cases\n' + JSON.stringify({ cases }) + '\n```',
  )
}
const view = async (id) => (await app.inject({ method: 'GET', url: '/api/items?v=2', headers: { cookie } })).json().items.find((it) => it.id === id)
const approve = (id, goldenHash) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/move`, headers: { cookie, 'x-human-key': pin }, payload: { action: 'approve', from: stepKeyAt(GATE), goldenHash } })
const setRow = (id) => db.prepare('SELECT * FROM golden_case_set WHERE item_id = ?').get(id)
const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor

test('FinTekkers: a case citing a doc not in the registry is refused at the gate, which stays pending', async () => {
  seed('VS-9721', fintekkers, [CASE, UNREGISTERED])
  const { goldenCases } = await view('VS-9721')
  assert.deepEqual(goldenCases.errors, ['case "stray": source unknown-doc#x is not in quant_resources.json'])
  assert.equal(goldenCases.cases[1].sourceIndexed, true, 'it is indexed: the registry, not the index, refuses it')
  const res = await approve('VS-9721', goldenCases.hash)
  assert.equal(res.statusCode, 409, res.body)
  assert.equal(res.json().error, 'golden_cases_invalid')
  assert.ok(res.json().errors.some((e) => /unknown-doc#x is not in quant_resources\.json/.test(e)), res.body)
  assert.equal(setRow('VS-9721'), undefined)
  assert.equal(cursorOf('VS-9721'), GATE)
})

test('FinTekkers: a set citing only registry docs is approved', async () => {
  seed('VS-9722', fintekkers, [CASE])
  const { goldenCases } = await view('VS-9722')
  assert.deepEqual(goldenCases.errors, [])
  const res = await approve('VS-9722', goldenCases.hash)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(setRow('VS-9722').hash, goldenCases.hash)
  assert.equal(cursorOf('VS-9722'), GATE + 1)
})

test('FinTekkers: a registry doc whose section is not indexed is still refused by the index check', async () => {
  seed('VS-9723', fintekkers, [{ ...CASE, source: `${BOND_MATHS}#missing` }])
  const { goldenCases } = await view('VS-9723')
  assert.deepEqual(goldenCases.errors, [`case "md": source ${BOND_MATHS}#missing is not in the knowledge index`])
})

test('Horizon has no registry: the same indexed doc is approved, exactly as before', async () => {
  seed('HO-9724', horizon, [UNREGISTERED])
  const { goldenCases } = await view('HO-9724')
  assert.deepEqual(goldenCases.errors, [])
  const res = await approve('HO-9724', goldenCases.hash)
  assert.equal(res.statusCode, 200, res.body)
  assert.ok(setRow('HO-9724'))
})

// ---- metric 5: on the box, the registry matches the store ----

const STORE = process.env.HORIZON_QUANT_RESOURCES_DIR || REGISTRY.store.path
const REQUIRE_STORE = process.env.HORIZON_REQUIRE_QUANT_STORE === '1'
const HAVE_STORE = existsSync(join(STORE, 'RESOURCES.json'))
const storeSkip = HAVE_STORE || REQUIRE_STORE ? false : `no quant store at ${STORE} (set HORIZON_REQUIRE_QUANT_STORE=1 to fail instead)`

test('the store is present when HORIZON_REQUIRE_QUANT_STORE=1', { skip: REQUIRE_STORE ? false : 'HORIZON_REQUIRE_QUANT_STORE is not set' }, () => {
  assert.ok(HAVE_STORE, `HORIZON_REQUIRE_QUANT_STORE=1 but ${STORE}/RESOURCES.json is missing`)
})

test('drift: the store is at store.sha, and every library and package matches RESOURCES.json', { skip: storeSkip }, () => {
  assert.equal(execFileSync('git', ['-C', STORE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), REGISTRY.store.sha, 'the store is not at store.sha')
  const resources = JSON.parse(readFileSync(join(STORE, 'RESOURCES.json'), 'utf8'))
  const problems = []
  const matched = new Set()
  for (const e of resources) {
    const kinds = e.kind === 'codebase' ? ['library'] : ['venv', 'python_package']
    const hits = REGISTRY.resources.filter((r) => kinds.includes(r.kind) && r.name === e.name)
    if (hits.length !== 1) {
      problems.push(`${e.kind} ${e.name}: ${hits.length} registry entries`)
      continue
    }
    const [r] = hits
    matched.add(r.id)
    const tag = e.kind === 'codebase' ? e.pinned_ref : e.pip_spec
    if (r.pinned?.tag !== tag) problems.push(`${r.id}: tag ${r.pinned?.tag} vs ${tag}`)
    if ((r.pinned?.sha ?? null) !== (e.commit_sha ?? null)) problems.push(`${r.id}: sha ${r.pinned?.sha} vs ${e.commit_sha}`)
    if (r.licence !== e.licence) problems.push(`${r.id}: licence ${r.licence} vs ${e.licence}`)
    const runOnly = /read and run only/i.test(e.notes ?? '')
    if ((r.use === 'read_and_run_only') !== runOnly) problems.push(`${r.id}: use ${r.use} vs notes ${JSON.stringify(e.notes)}`)
    if (e.kind === 'python-package' && (r.status === 'available') !== (e.installed === true)) problems.push(`${r.id}: status ${r.status} vs installed ${e.installed}`)
  }
  for (const r of REGISTRY.resources.filter((x) => ['library', 'venv', 'python_package'].includes(x.kind) && !matched.has(x.id))) {
    problems.push(`${r.id}: not in RESOURCES.json`)
  }
  assert.deepEqual(problems, [])
})

test('drift: every paper matches MANIFEST.md, and every downloaded one SHA256SUMS.txt and its own bytes', { skip: storeSkip }, () => {
  const STATUS = { '✅': 'downloaded', '🔒': 'paywalled', '❌': 'unavailable' }
  const manifest = readFileSync(join(STORE, 'papers/MANIFEST.md'), 'utf8')
  const rows = [...manifest.matchAll(/^\| `([^`]+\.pdf)` \|.*\| (✅|🔒|❌)[^|]*\|\s*$/gmu)].map((m) => ({ file: m[1], status: STATUS[m[2]] }))
  const browserOnly = [...manifest.matchAll(/^\|[^|]+\| (https?:\/\/\S+) \|[^|]*\| 🌐[^|]*\|\s*$/gmu)].map((m) => m[1])
  assert.ok(rows.length >= 30, `only ${rows.length} manifest rows parsed`)
  const sums = Object.fromEntries(
    readFileSync(join(STORE, 'papers/SHA256SUMS.txt'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/\s+\*?/))
      .map(([hash, file]) => [file, hash]),
  )
  const problems = []
  const papers = REGISTRY.resources.filter((r) => r.kind === 'paper')
  const fileOf = (r) => r.library?.path.replace(/^papers\//, '') ?? r.id
  for (const { file, status } of rows) {
    const stem = file.replace(/\.pdf$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const r = papers.find((p) => p.library?.path === `papers/${file}` || p.id === `paper-${stem}`)
    if (!r) {
      problems.push(`${file}: no registry entry`)
      continue
    }
    if (r.status !== status) problems.push(`${file}: status ${r.status} vs manifest ${status}`)
    if (status !== 'downloaded') continue
    if (r.sha256 !== sums[file]) problems.push(`${file}: sha256 ${r.sha256} vs SHA256SUMS ${sums[file]}`)
    const actual = createHash('sha256').update(readFileSync(join(STORE, 'papers', file))).digest('hex')
    if (actual !== r.sha256) problems.push(`${file}: the PDF hashes to ${actual}`)
  }
  for (const url of browserOnly) {
    if (!papers.some((p) => p.status === 'browser_only' && p.location === url)) problems.push(`browser-only ${url}: no registry entry`)
  }
  const downloaded = new Set(rows.filter((r) => r.status === 'downloaded').map((r) => r.file))
  for (const r of papers.filter((p) => p.status === 'downloaded' && !downloaded.has(fileOf(p)))) problems.push(`${r.id}: not downloaded in MANIFEST.md`)
  assert.equal(Object.keys(sums).length, downloaded.size, 'SHA256SUMS.txt and the manifest list the same number of PDFs')
  assert.deepEqual(problems, [])
})
