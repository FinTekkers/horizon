// HZ-972: FinTekkers' committed knowledge library, for the tests that check it
// (knowledge-fintekkers.test.mjs, golden-cases-vs164.test.mjs). Each document
// is a Markdown source beside the PDF the extract job reads.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const REPO_ROOT = join(import.meta.dirname, '../../..')
export const LIBRARY_REPO = 'FinTekkers/horizon'
export const KNOWLEDGE_DIR = 'farm/projects/fintekkers/knowledge'
export const DOC_NAMES = ['bond-maths', 'day-counts', 'settlement', 'tips']
export const pdfPath = (name) => `${KNOWLEDGE_DIR}/${name}.pdf`
export const markdownOf = (name) => readFileSync(join(REPO_ROOT, KNOWLEDGE_DIR, `${name}.md`), 'utf8')

// The section ids a document's Markdown declares: `## 3 Title {#id}`.
export function markdownTags(name) {
  return [...markdownOf(name).matchAll(/^## \d{1,3}(?:\.\d{1,3}){0,2} .*\{#([a-z0-9-]+)\}\s*$/gm)].map((m) => m[1])
}

// The section ids the farm's extract job indexes from each committed PDF, by
// document name: the real extractor (farm/knowledge.py extractor_path) and
// build_sections, so these are the ids a golden case's citation resolves to.
export function extractedSectionIds() {
  const script = [
    'import json, sys',
    'from pathlib import Path',
    'from farm import knowledge',
    'binary = knowledge.extractor_path()',
    'out = {}',
    'for name, path in json.load(sys.stdin).items():',
    '    out[name] = [s["id"] for s in knowledge.build_sections(knowledge.pdf_pages(binary, Path(path)))]',
    'sys.stdout.write(json.dumps(out))',
  ].join('\n')
  const env = { ...process.env }
  delete env.FARM_HOME
  const input = JSON.stringify(Object.fromEntries(DOC_NAMES.map((name) => [name, join(REPO_ROOT, pdfPath(name))])))
  return JSON.parse(execFileSync('python3', ['-W', 'ignore', '-c', script], { cwd: REPO_ROOT, env, input, encoding: 'utf8' }))
}
