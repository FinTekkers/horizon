// Metric 1: the site's own npm test reports pages, broken links, missing
// images and sales rows, and fails with each problem named by file and target
// (or CSV row and column).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PAGES, copySite, npmTest } from './helpers.mjs'
import { checkSite } from '../parvati-site/check-links.mjs'

test('npm test on a clean copy exits 0 and prints the totals', (t) => {
  const site = copySite(t)
  const { status, out } = npmTest(site)
  assert.equal(status, 0, out)
  for (const line of ['pages checked: 5', 'broken links: 0', 'missing images: 0', 'sales rows: 300', 'sales problems: 0']) {
    assert.match(out, new RegExp(`^${line}$`, 'm'), `expected "${line}" in:\n${out}`)
  }
})

test('a seeded broken link and missing image fail npm test, each named by file and target', (t) => {
  const site = copySite(t)
  const buy = path.join(site, 'buy.html')
  writeFileSync(buy, readFileSync(buy, 'utf8').replace('</body>', '<a href="nowhere.html">Nowhere</a>\n</body>'))
  rmSync(path.join(site, 'images', 'uws.jpg'))
  const { status, out } = npmTest(site)
  assert.notEqual(status, 0, out)
  for (const line of ['broken links: 1', 'missing images: 1', 'broken link: buy.html -> nowhere.html', 'missing image: buy.html -> images/uws.jpg']) {
    assert.match(out, new RegExp(`^${line}$`, 'm'), `expected "${line}" in:\n${out}`)
  }
})

test('blanking one sales.csv cell fails npm test, naming the row and column', (t) => {
  const site = copySite(t)
  const csv = path.join(site, 'data', 'sales.csv')
  const lines = readFileSync(csv, 'utf8').split('\n')
  // lines[0] is the fictional note and lines[1] the header, so data row 12 is lines[13].
  const cells = lines[13].split(',')
  cells[2] = '' // unit
  lines[13] = cells.join(',')
  writeFileSync(csv, lines.join('\n'))
  const { status, out } = npmTest(site)
  assert.notEqual(status, 0, out)
  assert.match(out, /^sales problem: data\/sales\.csv row 12, column unit: empty$/m, out)
})

test('checkSite reports an image that only styles.css references', async (t) => {
  const site = copySite(t)
  // ues.jpg is the Sell hero background, set in styles.css and in no page.
  for (const page of PAGES) {
    assert.doesNotMatch(readFileSync(path.join(site, page), 'utf8'), /ues\.jpg/)
  }
  rmSync(path.join(site, 'images', 'ues.jpg'))
  const r = await checkSite(site)
  assert.deepEqual(r.missingImages, [{ file: 'styles.css', target: 'images/ues.jpg' }])
  assert.deepEqual(r.broken, [])
})

test('checkSite skips external and same-page targets and fails ones outside the folder', async (t) => {
  const site = copySite(t)
  const about = path.join(site, 'about.html')
  const extra = '<a href="buy.html#form">a</a><a href="#top">b</a><a href="mailto:x">c</a><a href="./">d</a><a href="../outside.html">e</a><a href="/buy.html">f</a>'
  writeFileSync(about, readFileSync(about, 'utf8').replace('</body>', `${extra}\n</body>`))
  const r = await checkSite(site)
  assert.deepEqual(r.broken, [
    { file: 'about.html', target: '../outside.html' },
    { file: 'about.html', target: '/buy.html' },
  ])
})
