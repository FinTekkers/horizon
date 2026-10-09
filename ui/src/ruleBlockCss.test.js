// HZ-365 guardrail: the rule-block banner and card add no colours of their
// own — every colour in their rules is a theme token, so light and dark both
// hold.

import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i
const NEW_SELECTORS = [
  '.pause-banner__label',
  '.pause-banner__text',
  '.pause-banner__quote',
  '.pause-banner__toggle',
  '.pause-banner__actions',
  '.card__rule-block',
  '.card__rule-block-link',
  '.composer__submit--primary',
]

// Every rule whose selector list names `selector`, as [selector, body] pairs.
function rulesFor(selector) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, sel]) => sel.split(',').some((s) => s.trim().split(/[\s>:]/)[0] === selector))
    .map(([, sel, body]) => [sel.trim(), body])
}

test.each(NEW_SELECTORS)('%s uses theme tokens only: no hex, rgb() or hsl()', (selector) => {
  const rules = rulesFor(selector)
  expect(rules.length).toBeGreaterThan(0)
  for (const [, body] of rules) {
    expect(body).not.toMatch(COLOUR_LITERAL)
    for (const [, prop, value] of body.matchAll(/(?:^|;)\s*(background(?:-color)?|color|border(?:-(?:top|right|bottom|left))?(?:-color)?)\s*:\s*([^;]+)/g)) {
      if (/^(none|inherit|transparent)$/.test(value.trim())) continue
      expect(`${prop}: ${value}`).toMatch(/var\(--[\w-]+\)/)
    }
  }
})
