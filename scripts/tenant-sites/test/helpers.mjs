import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const SITE = path.resolve(import.meta.dirname, '../parvati-site')
export const PAGES = ['about.html', 'buy.html', 'contact.html', 'index.html', 'sell.html']

// A fresh copy of the site in a temp dir, removed when the test ends.
export function copySite(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'parvati-site-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const copy = path.join(dir, 'parvati-site')
  cpSync(SITE, copy, { recursive: true, filter: (src) => path.basename(src) !== 'node_modules' })
  return copy
}

// The site's own `npm test`, run in `cwd`. npm_* variables from an outer npm
// run (npm --prefix ... test) are dropped so the inner npm uses `cwd` only.
export function npmTest(cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toLowerCase().startsWith('npm_')))
  const r = spawnSync('npm', ['test'], { cwd, env, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}
