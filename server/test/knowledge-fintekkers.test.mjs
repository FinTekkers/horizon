// HZ-972 metric 3: FinTekkers' knowledge sources. With the project's
// definitions switch on, listSources() returns the four committed documents
// (bond maths, day counts, settlement, TIPS) named by
// farm/projects/fintekkers/personas.json, then the papers in the private
// FinTekkers/quant-library repo that quant_resources.json lists. Each declares its section ids,
// including the four the metric names, and cites a primary source; each PDF
// is exactly what scripts/knowledge-pdfs.mjs renders from its Markdown, and
// the extract job indexes it to exactly those ids.
//
// Runs against the REAL farm tree (no HORIZON_FARM_DIR override), so the
// committed files are what is read.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOC_NAMES, LIBRARY_REPO, REPO_ROOT, extractedSectionIds, markdownOf, markdownTags, pdfPath } from './helpers/fintekkersKnowledge.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-hz972-knowledge-')), 'test.db')
delete process.env.HORIZON_FARM_DIR
for (const key of ['FARM_URL', 'GITHUB_WEBHOOK_SECRET', 'HORIZON_REPO']) delete process.env[key]

const { db } = await import('../src/db.js')
const { knowledgeSlug, listSources } = await import('../src/knowledgeDocs.js')
const { pdfFor } = await import('../../scripts/knowledge-pdfs.mjs')

const projectId = Number(db.prepare("INSERT INTO project (name, definitions_enabled, isolation) VALUES ('FinTekkers', 1, 'internal')").run().lastInsertRowid)
db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'FinTekkers/valuation-service', 'VS')").run(projectId)

const REQUIRED = { 'bond-maths': 'modified-duration', 'day-counts': 'act-act-icma', settlement: 't-plus-1', tips: 'index-ratio' }

test('listSources() returns the four documents for FinTekkers first, each under its derived slug', () => {
  const sources = listSources().filter((s) => s.projectId === projectId)
  assert.deepEqual(
    sources.slice(0, DOC_NAMES.length).map(({ slug, repo, path, isolation }) => ({ slug, repo, path, isolation })),
    DOC_NAMES.map((name) => ({ slug: knowledgeSlug(LIBRARY_REPO, pdfPath(name)), repo: LIBRARY_REPO, path: pdfPath(name), isolation: 'internal' })),
  )
})

test('then the downloaded quant-library papers, exactly the ones quant_resources.json lists', () => {
  const registry = JSON.parse(readFileSync(join(REPO_ROOT, 'farm/projects/fintekkers/quant_resources.json'), 'utf8'))
  const papers = registry.resources.filter((r) => r.kind === 'paper' && r.status === 'downloaded').map((r) => r.library)
  assert.ok(papers.length >= 30, `only ${papers.length} downloaded papers`)
  const sources = listSources().filter((s) => s.projectId === projectId).slice(DOC_NAMES.length)
  assert.deepEqual(
    sources.map(({ slug, repo, path }) => ({ slug, repo, path })),
    papers.map(({ repo, path }) => ({ slug: knowledgeSlug(repo, path), repo, path })),
  )
  assert.ok(sources.every((s) => s.repo === 'FinTekkers/quant-library' && /^papers\/[a-z0-9_.]+\.pdf$/.test(s.path)))
})

test('with the switch off, FinTekkers lists no sources', () => {
  db.prepare('UPDATE project SET definitions_enabled = 0 WHERE id = ?').run(projectId)
  try {
    assert.deepEqual(listSources().filter((s) => s.projectId === projectId), [])
  } finally {
    db.prepare('UPDATE project SET definitions_enabled = 1 WHERE id = ?').run(projectId)
  }
})

for (const name of DOC_NAMES) {
  test(`${name}: declares its section ids, including ${REQUIRED[name]}, and cites a primary source`, () => {
    const tags = markdownTags(name)
    assert.ok(tags.includes(REQUIRED[name]), tags.join(', '))
    assert.equal(new Set(tags).size, tags.length, 'section ids are unique')
    const sources = markdownOf(name).split(/^## Sources\s*$/m)[1] ?? ''
    assert.match(sources, /https:\/\/\S+/, 'at least one primary-source URL under ## Sources')
  })

  test(`${name}: the committed PDF is the rendering of its Markdown`, () => {
    assert.ok(readFileSync(join(REPO_ROOT, pdfPath(name))).equals(pdfFor(join(REPO_ROOT, pdfPath(name).replace(/\.pdf$/, '.md')))), 'run node scripts/knowledge-pdfs.mjs')
  })
}

test('the extract job indexes each PDF to exactly the ids its Markdown declares', () => {
  const extracted = extractedSectionIds()
  for (const name of DOC_NAMES) assert.deepEqual(extracted[name], markdownTags(name), name)
})
