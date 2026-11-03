// The site's own check (npm test): every local link and image in every page
// and stylesheet must resolve to a file in this folder, and data/sales.csv must
// pass data/check-sales.mjs. Prints the totals, then one line per failure:
//
//   pages checked: 5
//   broken links: 1
//   missing images: 0
//   broken link: buy.html -> nowhere.html
//
// It finds pages by walking the folder, so a page added later (Chapter B adds
// neighbourhoods.html) is checked with no change here. No network calls:
// http(s), mailto, tel and data targets are skipped.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkSales, formatSales } from './data/check-sales.mjs'

const SKIP_DIRS = new Set(['node_modules'])

function walk(dir, root = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(path.join(dir, entry.name), root, out)
    } else if (entry.isFile()) {
      out.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'))
    }
  }
  return out.sort()
}

const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")

// Every reference in one file, as { kind: 'link' | 'image', target }.
function references(text, isHtml) {
  const refs = []
  if (isHtml) {
    const html = text.replace(/<!--[\s\S]*?-->/g, '')
    for (const m of html.matchAll(/\s(href|src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const attr = m[1].toLowerCase()
      const value = decodeEntities(m[2] ?? m[3])
      if (attr === 'href') refs.push({ kind: 'link', target: value })
      else if (attr === 'src') refs.push({ kind: 'image', target: value })
      else for (const part of value.split(',')) refs.push({ kind: 'image', target: part.trim().split(/\s+/)[0] })
    }
    text = html
  } else {
    text = text.replace(/\/\*[\s\S]*?\*\//g, '')
  }
  for (const m of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi)) {
    refs.push({ kind: 'image', target: decodeEntities((m[1] ?? m[2] ?? m[3]).trim()) })
  }
  return refs
}

// Scheme-qualified (http:, mailto:, data:, ...), protocol-relative and
// same-page targets are not files in this folder.
const isExternal = (target) => target === '' || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)

function resolves(root, fromFile, target) {
  let clean = target.replace(/[?#].*$/, '')
  try {
    clean = decodeURIComponent(clean)
  } catch {
    return false
  }
  // A root-relative "/x" would point outside a project Pages site, so it
  // resolves against the filesystem root and fails the inside-root test below.
  const abs = path.resolve(path.dirname(path.join(root, fromFile)), clean)
  const rel = path.relative(root, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false
  try {
    const st = statSync(abs)
    if (st.isFile()) return true
    return st.isDirectory() && statSync(path.join(abs, 'index.html')).isFile()
  } catch {
    return false
  }
}

export async function checkSite(dir) {
  const root = path.resolve(dir)
  const files = walk(root)
  const pages = files.filter((f) => f.endsWith('.html'))
  const sources = files.filter((f) => f.endsWith('.html') || f.endsWith('.css'))
  const broken = []
  const missingImages = []
  for (const file of sources) {
    for (const ref of references(readFileSync(path.join(root, file), 'utf8'), file.endsWith('.html'))) {
      if (isExternal(ref.target) || resolves(root, file, ref.target)) continue
      ;(ref.kind === 'link' ? broken : missingImages).push({ file, target: ref.target })
    }
  }
  return { pages, broken, missingImages }
}

export function formatResult(r) {
  return [
    `pages checked: ${r.pages.length}`,
    `broken links: ${r.broken.length}`,
    `missing images: ${r.missingImages.length}`,
    ...r.broken.map((b) => `broken link: ${b.file} -> ${b.target}`),
    ...r.missingImages.map((m) => `missing image: ${m.file} -> ${m.target}`),
  ].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const site = await checkSite(here)
  const sales = checkSales(path.join(here, 'data', 'sales.csv'))
  console.log(formatResult(site))
  console.log(formatSales(sales))
  const failed = site.pages.length === 0 || site.broken.length > 0 || site.missingImages.length > 0 || sales.problems.length > 0
  process.exit(failed ? 1 : 0)
}
