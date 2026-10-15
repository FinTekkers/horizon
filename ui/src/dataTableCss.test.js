// HZ-462 guardrail 2, checked statically: the shared .data-table rules use
// only CSS variables index.css already defines, the evidence ref is the mono
// id style, and the wrapper scrolls a wide table instead of the page.

import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.css'), 'utf8')

// Every top-level rule whose selector names .data-table, as [selector, body].
const rules = [...css.matchAll(/([^{}]*\.data-table[^{}]*)\{([^}]*)\}/g)].map((m) => [m[1].trim(), m[2]])
const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))

test('the .data-table rules exist', () => {
  const selectors = rules.map(([selector]) => selector)
  expect(selectors.some((s) => s.endsWith('.data-table-wrap'))).toBe(true)
  expect(selectors.some((s) => s.endsWith('.data-table'))).toBe(true)
  expect(selectors.some((s) => s.endsWith('.data-table__ref'))).toBe(true)
})

test('every var(--…) in the .data-table rules is already defined', () => {
  const used = rules.flatMap(([, body]) => [...body.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]))
  expect(used.length).toBeGreaterThan(0)
  for (const name of used) expect(defined.has(name), `${name} is not defined in index.css`).toBe(true)
})

test('the ref is mono, and the wrapper scrolls sideways', () => {
  const body = (suffix) => rules.find(([selector]) => selector.endsWith(suffix))[1]
  expect(body('.data-table__ref')).toContain('var(--font-mono)')
  expect(body('.data-table-wrap')).toMatch(/overflow-x:\s*auto/)
})
