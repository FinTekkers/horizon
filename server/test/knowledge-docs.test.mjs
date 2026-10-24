// HZ-537: the knowledge_doc rows farmd's extract job (farm/knowledge.py)
// reports, through the real Fastify app, with a temp HORIZON_FARM_DIR holding
// farm/projects/<slug>/personas.json. Every persona and doc below is fabricated.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const farmDir = mkdtempSync(join(tmpdir(), 'horizon-knowledge-docs-farm-'))
process.env.HORIZON_FARM_DIR = farmDir
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-knowledge-docs-')), 'test.db')
process.env.FARM_SHARED_SECRET = 'knowledge-farm-secret'
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { PROVIDERS } = await import('../../domain/js/providers.js')
const CLAUDE_MODEL = PROVIDERS.find((p) => p.name === 'claude').models[0].id
const QUANT = { id: 'quant', agent: 'eng', label: 'Quant', initials: 'QT', color: '#2E6CB2', model: CLAUDE_MODEL, provider: 'claude', file: 'quant.md' }
const KNOWLEDGE = [{ path: 'docs/specs/Bond-Spec.pdf' }, { repo: 'Acme/handbooks', path: 'pricing.pdf' }]

function writeProject(slug, personas) {
  mkdirSync(join(farmDir, 'projects', slug, 'personas'), { recursive: true })
  writeFileSync(join(farmDir, 'projects', slug, 'personas.json'), JSON.stringify({ personas }))
  writeFileSync(join(farmDir, 'projects', slug, 'personas', 'quant.md'), 'Think like a quant.\n')
}

writeProject('acme-knowledge', [{ ...QUANT, knowledge: KNOWLEDGE }])
writeProject('acme-switched-off', [{ ...QUANT, knowledge: KNOWLEDGE }])

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const knowledgeDocs = await import('../src/knowledgeDocs.js')

const addProject = (name, repo, prefix, definitionsEnabled) => {
  const id = Number(db.prepare('INSERT INTO project (name, definitions_enabled) VALUES (?, ?)').run(name, definitionsEnabled).lastInsertRowid)
  db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(id, repo, prefix)
  return id
}
const ON = addProject('Acme Knowledge', 'Acme/app', 'AK', 1)
const OFF = addProject('Acme Switched Off', 'Acme/other', 'AO', 0)

const app = buildApp({ logger: false })
await app.ready()

const FARM = { 'x-farm-secret': 'knowledge-farm-secret' }
const SHA_1 = 'a'.repeat(40)
const SHA_2 = 'b'.repeat(40)
const OWN_SLUG = 'app__docs-specs-bond-spec'
const DOCS_SLUG = 'handbooks__pricing'
const body = (overrides = {}) => ({
  repo: 'Acme/app',
  path: 'docs/specs/Bond-Spec.pdf',
  sourceSha: SHA_1,
  status: 'extracted',
  pageCount: 12,
  sectionCount: 2,
  sections: [
    { id: '1-scope', title: '1 Scope', page: 1 },
    { id: '2-pricing', title: '2 Pricing', page: 4 },
  ],
  error: null,
  ...overrides,
})
const put = (projectId, slug, payload, headers = FARM) =>
  app.inject({ method: 'PUT', url: `/api/farm/knowledge/docs/${projectId}/${slug}`, headers, payload })
const sources = (headers = FARM) => app.inject({ method: 'GET', url: '/api/farm/knowledge/sources', headers })

test('the sources are the switched-on project persona references, with the slug derived once', async () => {
  const res = await sources()
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    sources: [
      { projectId: ON, slug: OWN_SLUG, repo: 'Acme/app', path: 'docs/specs/Bond-Spec.pdf', lastSha: null, status: null },
      { projectId: ON, slug: DOCS_SLUG, repo: 'Acme/handbooks', path: 'pricing.pdf', lastSha: null, status: null },
    ],
  })
  assert.equal(knowledgeDocs.knowledgeSlug('Acme/handbooks', 'pricing.pdf'), DOCS_SLUG)
})

test('two PUTs keep one row: a new sha updates it in place', async () => {
  const first = await put(ON, OWN_SLUG, body())
  assert.equal(first.statusCode, 200)
  assert.deepEqual(first.json(), { ok: true, changed: true })
  const row1 = db.prepare('SELECT * FROM knowledge_doc WHERE project_id = ? AND slug = ?').get(ON, OWN_SLUG)
  assert.equal(row1.status, 'extracted')
  assert.equal(row1.source_sha, SHA_1)

  const same = await put(ON, OWN_SLUG, body())
  assert.deepEqual(same.json(), { ok: true, changed: false })

  const second = await put(ON, OWN_SLUG, body({ sourceSha: SHA_2, pageCount: 20, sectionCount: 1, sections: [{ id: 'p1', title: 'Page 1', page: 1 }] }))
  assert.deepEqual(second.json(), { ok: true, changed: true })
  const rows = db.prepare('SELECT * FROM knowledge_doc WHERE project_id = ?').all(ON)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, row1.id)
  assert.equal(rows[0].source_sha, SHA_2)
  assert.equal(rows[0].page_count, 20)
  assert.equal(rows[0].section_count, 1)
  assert.deepEqual(knowledgeDocs.docsForProject(ON), [
    { slug: OWN_SLUG, status: 'extracted', pageCount: 20, sectionCount: 1, sections: [{ id: 'p1', title: 'Page 1', page: 1 }] },
  ])

  const listed = (await sources()).json().sources.find((s) => s.slug === OWN_SLUG)
  assert.equal(listed.lastSha, SHA_2)
  assert.equal(listed.status, 'extracted')
})

test('a failed extract is recorded with zero counts', async () => {
  const res = await put(ON, DOCS_SLUG, body({ repo: 'Acme/handbooks', path: 'pricing.pdf', status: 'failed', pageCount: 0, sectionCount: 0, sections: [], error: 'pdf2txt.py failed: bad xref' }))
  assert.equal(res.statusCode, 200)
  const row = db.prepare('SELECT * FROM knowledge_doc WHERE project_id = ? AND slug = ?').get(ON, DOCS_SLUG)
  assert.equal(row.status, 'failed')
  assert.equal(row.page_count, 0)
  assert.equal(row.section_count, 0)
  assert.equal(row.error, 'pdf2txt.py failed: bad xref')
})

test('an unknown source is 404 and writes nothing', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM knowledge_doc').get().n
  for (const [projectId, slug, payload] of [
    [ON, 'nope__missing', body()],
    [ON, OWN_SLUG, body({ path: 'docs/other.pdf' })],
    [OFF, OWN_SLUG.replace('app__', 'other__'), body({ repo: 'Acme/other' })],
    [999, OWN_SLUG, body()],
  ]) {
    const res = await put(projectId, slug, payload)
    assert.equal(res.statusCode, 404, `${projectId}/${slug}`)
    assert.deepEqual(res.json(), { error: 'unknown_source' })
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM knowledge_doc').get().n, before)
})

test('with the switch off the project lists no source', async () => {
  const listed = (await sources()).json().sources
  assert.ok(listed.length > 0)
  assert.ok(listed.every((s) => s.projectId === ON))
  db.prepare('UPDATE project SET definitions_enabled = 0 WHERE id = ?').run(ON)
  try {
    assert.deepEqual((await sources()).json(), { sources: [] })
  } finally {
    db.prepare('UPDATE project SET definitions_enabled = 1 WHERE id = ?').run(ON)
  }
})

test('both routes refuse a request without the farm secret', async () => {
  assert.equal((await sources({})).statusCode, 401)
  assert.equal((await put(ON, OWN_SLUG, body(), {})).statusCode, 401)
})

test('a malformed report is 400', async () => {
  assert.equal((await put(ON, OWN_SLUG, body({ status: 'pending' }))).statusCode, 400)
  assert.equal((await put(ON, OWN_SLUG, body({ pageCount: -1 }))).statusCode, 400)
  assert.equal((await put(ON, '..%2Fx', body())).statusCode, 400)
})
