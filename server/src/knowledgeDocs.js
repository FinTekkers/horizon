// HZ-537: the knowledge library's server side — which PDFs the farm should
// extract, and the knowledge_doc rows it reports back (db.js).
//
// A source is a reference a project persona names in its optional `knowledge`
// array (farm/projects/<slug>/personas.json, domain/projectPersonas.schema.json):
// { path } is a PDF in the project's own repo — its first connected repo — and
// { repo, path } a PDF in a docs repo. Only projects whose definitions switch
// (project.definitions_enabled, HZ-535) is on have sources; with it off, or no
// personas.json, listSources() returns nothing for the project and the farm
// does no work for it.
//
// The doc slug is derived here, by knowledgeSlug(), and nowhere else: the farm
// takes it off listSources() and only checks its shape before using it as the
// cache directory name. It is also the `<doc>` of a `<doc>#<section>` citation.
// Two projects naming the same repo and path share one slug, and so one cache
// directory, but each keeps its own row.

import { db } from './db.js'
import { projectPersonaOverlay } from './definitions.js'

export const SLUG_SHAPE = /^[a-z0-9_-]+$/

const slugPart = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

// 'FinTekkers/docs' + 'specs/bond-spec.pdf' -> 'docs__specs-bond-spec'.
export function knowledgeSlug(repo, path) {
  return `${slugPart(repo.split('/').pop())}__${slugPart(path.replace(/\.pdf$/i, ''))}`
}

const selectSwitchedOnProjects = db.prepare('SELECT id, name, definitions_enabled FROM project WHERE definitions_enabled = 1 ORDER BY id')
const selectFirstRepo = db.prepare('SELECT repo FROM project_repo WHERE project_id = ? ORDER BY id LIMIT 1')
const selectDoc = db.prepare('SELECT * FROM knowledge_doc WHERE project_id = ? AND slug = ?')
const selectProjectDocs = db.prepare('SELECT * FROM knowledge_doc WHERE project_id = ? ORDER BY slug')

// [{ projectId, slug, repo, path }] for one project row, in persona order. A
// repo-path source in a project with no connected repo is skipped, and so is
// a second reference that lands on a slug already listed.
function projectSources(project) {
  const overlay = projectPersonaOverlay(project)
  if (!overlay) return []
  const ownRepo = selectFirstRepo.get(project.id)?.repo ?? null
  const sources = []
  const seen = new Set()
  for (const refs of Object.values(overlay.knowledge)) {
    for (const ref of refs) {
      const repo = ref.repo ?? ownRepo
      if (!repo) continue
      const slug = knowledgeSlug(repo, ref.path)
      if (seen.has(slug) || !SLUG_SHAPE.test(slug)) continue
      seen.add(slug)
      sources.push({ projectId: project.id, slug, repo, path: ref.path })
    }
  }
  return sources
}

// Every current source, joined to its row: lastSha and status are null for a
// source never extracted.
export function listSources() {
  return selectSwitchedOnProjects.all().flatMap((project) =>
    projectSources(project).map((source) => {
      const row = selectDoc.get(source.projectId, source.slug)
      return { ...source, lastSha: row?.source_sha ?? null, status: row?.status ?? null }
    }),
  )
}

// The farm's report for one doc. { error: 'unknown_source' } unless
// (projectId, slug) is a current source with the same repo and path. Otherwise
// inserts the row or updates it in place (same id); `changed` is false when
// the sha and status already match.
export function upsertDoc(projectId, slug, body) {
  const project = selectSwitchedOnProjects.all().find((p) => p.id === projectId)
  const source = project && projectSources(project).find((s) => s.slug === slug)
  if (!source || source.repo !== body.repo || source.path !== body.path) return { error: 'unknown_source' }
  const prior = selectDoc.get(projectId, slug)
  db.prepare(
    `INSERT INTO knowledge_doc
       (project_id, slug, repo, path, source_sha, status, page_count, section_count, sections_json, error, extracted_at)
     VALUES (@projectId, @slug, @repo, @path, @sourceSha, @status, @pageCount, @sectionCount, @sectionsJson, @error, datetime('now'))
     ON CONFLICT (project_id, slug) DO UPDATE SET
       repo = excluded.repo, path = excluded.path, source_sha = excluded.source_sha, status = excluded.status,
       page_count = excluded.page_count, section_count = excluded.section_count,
       sections_json = excluded.sections_json, error = excluded.error, extracted_at = excluded.extracted_at`,
  ).run({
    projectId,
    slug,
    repo: body.repo,
    path: body.path,
    sourceSha: body.sourceSha,
    status: body.status,
    pageCount: body.pageCount,
    sectionCount: body.sectionCount,
    sectionsJson: JSON.stringify(body.sections ?? []),
    error: body.error ?? null,
  })
  return { changed: !prior || prior.source_sha !== body.sourceSha || prior.status !== body.status }
}

// The rows for one project — the one read path for the `## Knowledge` index.
export function docsForProject(projectId) {
  return selectProjectDocs.all(projectId).map((row) => ({
    slug: row.slug,
    status: row.status,
    pageCount: row.page_count,
    sectionCount: row.section_count,
    sections: JSON.parse(row.sections_json),
  }))
}
