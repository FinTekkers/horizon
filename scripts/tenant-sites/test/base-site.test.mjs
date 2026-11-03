// Metric 2: the base site has exactly Home, Buy, Sell, About and Contact, each
// with the same header linking Buy, Sell, About and Contact, and no
// Neighbourhoods page or link (Chapter B adds them on camera, HZ-701).
//
// This lives outside the site's own npm test on purpose: once Chapter B adds a
// page, "exactly five pages" is meant to stop holding, but the site's npm test
// must keep passing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { PAGES, SITE } from './helpers.mjs'

const read = (page) => readFileSync(path.join(SITE, page), 'utf8')
const only = (text, re, what) => {
  const found = text.match(new RegExp(re.source, 'g')) ?? []
  assert.equal(found.length, 1, `expected exactly one ${what}, found ${found.length}`)
  return found[0]
}
const navOf = (page) => only(read(page), /<nav class="pv-navrow"[^>]*>[\s\S]*?<\/nav>/, `pv-navrow nav in ${page}`)
const footerOf = (page) => only(read(page), /<footer[\s\S]*?<\/footer>/, `footer in ${page}`)
const anchors = (html) => [...html.matchAll(/<a\s([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
  attrs: m[1],
  href: m[1].match(/href="([^"]*)"/)?.[1],
  text: m[2].replace(/<[^>]*>/g, '').trim(),
}))
const ACTIVE = { 'buy.html': 'Buy', 'sell.html': 'Sell', 'about.html': 'About', 'contact.html': 'Contact', 'index.html': null }
const files = () => readdirSync(SITE, { recursive: true }).map(String)

test('the site has exactly the Home, Buy, Sell, About and Contact pages', () => {
  assert.deepEqual(files().filter((f) => f.endsWith('.html')).sort(), PAGES)
})

test('every page has the shared header, linking Buy, Sell, About and Contact by visible text', () => {
  for (const page of PAGES) {
    const links = anchors(navOf(page))
    for (const label of ['Buy', 'Sell', 'About', 'Contact']) {
      const link = links.find((a) => a.text === label)
      assert.ok(link, `${page}: no "${label}" link in the header`)
      assert.equal(link.href, `${label.toLowerCase()}.html`, `${page}: "${label}" links ${link.href}`)
    }
    const current = links.filter((a) => /aria-current="page"/.test(a.attrs)).map((a) => a.text)
    assert.deepEqual(current, ACTIVE[page] ? [ACTIVE[page]] : [], `${page}: aria-current on ${current}`)
  }
  const bare = PAGES.map((page) => navOf(page).replace(/ aria-current="page"/g, ''))
  for (const [i, nav] of bare.entries()) assert.equal(nav, bare[0], `${PAGES[i]} header differs from ${PAGES[0]}`)
})

test('every page has the same footer, and the contact band on all but Contact', () => {
  for (const page of PAGES) {
    assert.equal(footerOf(page), footerOf(PAGES[0]), `${page} footer differs from ${PAGES[0]}`)
    const bands = read(page).match(/class="pv-band"/g)?.length ?? 0
    assert.equal(bands, page === 'contact.html' ? 0 : 1, `${page}: ${bands} contact bands`)
  }
})

test('no Neighbourhoods page, link or header label', () => {
  // Page text is not scanned: the Sell table and the Buy search form have a
  // "Neighbourhood" column or field, and the Home copy says "neighbourhoods".
  const hood = /neighbo(u)?rhood/i
  assert.deepEqual(files().filter((f) => hood.test(f)), [])
  for (const page of PAGES) {
    for (const a of anchors(read(page))) assert.doesNotMatch(a.href ?? '', hood, `${page} links ${a.href}`)
    for (const a of anchors(navOf(page))) assert.doesNotMatch(a.text, hood, `${page} header label ${a.text}`)
  }
})
