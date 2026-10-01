// HZ-224 guardrails, checked statically: the mobile layout uses theme tokens
// only (so dark mode works), and the 699px breakpoint has exactly one CSS
// copy plus its MOBILE_QUERY twin — no width sniffing scattered elsewhere.

import { expect, test } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MOBILE_QUERY } from './useMediaQuery'

const SRC = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(join(SRC, rel), 'utf8')
const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i

// The body of the one `@media ${MOBILE_QUERY}` block, braces balanced.
function mobileBlock(css) {
  const start = css.indexOf(`@media ${MOBILE_QUERY}`)
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i)
  }
  throw new Error('unbalanced mobile @media block')
}

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(jsx?|css)$/.test(entry.name) ? [path] : []
  })
}

test('index.css has exactly one mobile breakpoint, and it is MOBILE_QUERY', () => {
  const css = read('index.css')
  expect(MOBILE_QUERY).toBe('(max-width: 699px)')
  expect(css.split(`@media ${MOBILE_QUERY}`).length - 1).toBe(1)
})

test('the mobile block, BottomNav and its new icons contain no hard-coded colours', () => {
  const block = mobileBlock(read('index.css'))
  expect(block).toContain('.bottomnav')
  expect(block).not.toMatch(COLOUR_LITERAL)

  expect(read('components/BottomNav.jsx')).not.toMatch(COLOUR_LITERAL)

  const icons = read('components/icons.jsx')
  for (const name of ['ColumnsIcon', 'ListIcon']) {
    const body = icons.match(new RegExp(`export function ${name}[\\s\\S]*?\\n}\\n`))
    expect(body, `${name} not found in icons.jsx`).not.toBeNull()
    expect(body[0]).not.toMatch(COLOUR_LITERAL)
    expect(body[0]).not.toMatch(/stroke=|fill=/)
  }
})

test('no source file sniffs the viewport width or the user agent', () => {
  const self = fileURLToPath(import.meta.url)
  const offenders = sourceFiles(SRC)
    .filter((path) => path !== self)
    .filter((path) => /\binnerWidth\b|navigator\.userAgent/.test(readFileSync(path, 'utf8')))
  expect(offenders).toEqual([])
})
