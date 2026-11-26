#!/usr/bin/env node
// HZ-972: renders a knowledge library's Markdown sources to the PDFs the
// knowledge extract job reads (farm/knowledge.py, HZ-537). Run on demand,
// never in CI, after editing a source:
//
//   node scripts/knowledge-pdfs.mjs [dir]    (default farm/projects/fintekkers/knowledge)
//
// Every <name>.md in the directory becomes <name>.pdf beside it. The PDF is a
// plain text rendering, one PDF line per Markdown line, so the extractor sees
// each `## 3 Modified duration {#modified-duration}` heading as its own line
// and takes the section id from the tag. No dependency and no timestamp: the
// same Markdown always gives the same bytes, which
// server/test/knowledge-fintekkers.test.mjs checks against the committed PDFs.
//
// It refuses what the extractor would misread: a non-ASCII character, a line
// too long to fit, or a body line that looks like a numbered heading (it
// would open a section of its own).

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FONT_SIZE = 9
const LEADING = 12
const LINES_PER_PAGE = 58
const MAX_CHARS = 90
const LEFT = 54
const TOP = 760
// farm/knowledge.py's HEADING, which runs on each stripped line.
const HEADING = /^(\d{1,3}(?:\.\d{1,3}){0,2})\.?\s+([A-Za-z].*)$/

export const DEFAULT_DIR = fileURLToPath(new URL('../farm/projects/fintekkers/knowledge', import.meta.url))

// The text lines of one Markdown source, or throws naming the line.
export function markdownLines(markdown, name = 'source') {
  const out = []
  markdown.split('\n').forEach((raw, i) => {
    const where = `${name}:${i + 1}`
    if (/[^\x20-\x7E]/.test(raw)) throw new Error(`${where}: only printable ASCII renders`)
    if (raw.startsWith('```')) return
    const heading = /^#{1,6}\s+(.*)$/.exec(raw)
    const line = heading ? heading[1] : raw
    if (line.length > MAX_CHARS) throw new Error(`${where}: longer than ${MAX_CHARS} characters`)
    if (!(heading && raw.startsWith('## ')) && HEADING.test(line.trim())) {
      throw new Error(`${where}: a body line the extractor would read as a numbered heading`)
    }
    out.push(line)
  })
  while (out.length && out.at(-1) === '') out.pop()
  return out
}

const escape = (text) => text.replace(/[\\()]/g, (c) => `\\${c}`)

// A minimal PDF 1.4: Courier text, LINES_PER_PAGE lines a page.
export function renderPdf(lines) {
  const pages = []
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE))
  if (!pages.length) pages.push([])
  const font = 3 + 2 * pages.length
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>']
  objs.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + 2 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`)
  pages.forEach((page, i) => {
    const content = `BT /F1 ${FONT_SIZE} Tf ${LEFT} ${TOP} Td ${LEADING} TL ${page.map((line) => `(${escape(line)}) Tj T*`).join(' ')} ET`
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + 2 * i} 0 R >>`)
    objs.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`)
  })
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>')
  let out = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(out))
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

export function pdfFor(markdownPath) {
  return renderPdf(markdownLines(readFileSync(markdownPath, 'utf8'), markdownPath))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? DEFAULT_DIR)
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    const pdf = join(dir, name.replace(/\.md$/, '.pdf'))
    writeFileSync(pdf, pdfFor(join(dir, name)))
    console.log(`wrote ${pdf}`)
  }
}
