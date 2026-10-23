// HZ-546: Markdown renders well-formed code references as GitHub links at the
// step's recorded sha, and known item IDs as links to their Horizon page —
// only when given a linkContext. Contexts come from the shared fixture
// (domain/fixtures/code-ref-cases.json), the same one the server suite runs.

import { afterEach, expect, test } from 'vitest'
import { render, cleanup, screen, within } from '@testing-library/react'

import Markdown from './Markdown'
import { buildLinkContext } from '../../../domain/js/codeRefs.js'
import fixture from '../../../domain/fixtures/code-ref-cases.json'

afterEach(() => cleanup())

const itemHref = (id) => `/horizon/${id.toLowerCase()}`
const contextFor = (name, extra = {}) => buildLinkContext({ ...fixture.contexts[name], itemHref, ...extra })
const UI_SHA = fixture.contexts.plan.sourceShas['FinTekkers/ui-service']
const HZ_SHA = fixture.contexts.change.sourceShas['FinTekkers/horizon']

// Guardrail 4: what Markdown rendered before HZ-546, with no linkContext.
// The snapshot below was recorded from the pre-change component.
const CORPUS = [
  '## Heading with `code`',
  '',
  'A paragraph: `ui-service:src/routes/treasuries/+page.server.ts:339-342`, `src/x.ts:12`, US-243 and [a link](https://example.com/x).',
  '',
  '- item one with `npm test`',
  '- item two with **US-243**',
  '',
  '| a | b |',
  '| - | - |',
  '| US-243 | `c` |',
  '',
  '<img src=x onerror=1> & done',
].join('\n')

test('guardrail 4: without a linkContext the output is unchanged', () => {
  const { container } = render(<Markdown text={CORPUS} />)
  expect(container.innerHTML).toMatchInlineSnapshot(`
    "<div class="md-body"><h4>Heading with <code>code</code></h4><p>A paragraph: <code>ui-service:src/routes/treasuries/+page.server.ts:339-342</code>, <code>src/x.ts:12</code>, US-243 and <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">a link</a>.</p><ul><li>item one with <code>npm test</code></li><li>item two with <strong>US-243</strong></li></ul><p>| a | b |
    | - | - |
    | US-243 | \`c\` |</p><p>&lt;img src=x onerror=1&gt; &amp; done</p></div>"
  `)
})

const METRIC_1 = [
  'The handler is `ui-service:src/routes/treasuries/+page.server.ts:339-342`.',
  '',
  'Also `:342-363`, `passthrough.rs:184-197` and `npm test`.',
].join('\n')

test('metric 1: a multi-repo reference links at the fixture’s sha; the others stay plain code spans', () => {
  const { container } = render(<Markdown text={METRIC_1} linkContext={contextFor('plan', { knownIds: new Set(['US-243']) })} />)
  const link = screen.getByRole('link', { name: 'ui-service:src/routes/treasuries/+page.server.ts:339-342' })
  expect(link.getAttribute('href')).toBe(
    `https://github.com/FinTekkers/ui-service/blob/${UI_SHA}/src/routes/treasuries/+page.server.ts#L339-L342`,
  )
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toContain('noopener')
  expect(screen.getAllByRole('link')).toHaveLength(1)
  for (const plain of [':342-363', 'passthrough.rs:184-197', 'npm test']) {
    const code = [...container.querySelectorAll('code')].find((el) => el.textContent === plain)
    expect(code, plain).toBeTruthy()
    expect(code.closest('a'), plain).toBeNull()
  }
})

test('metric 2: in a single-repo Change a bare path links to the item’s repo, a known id links, an unknown one stays text', () => {
  const ctx = contextFor('change', { knownIds: new Set(['US-243']) })
  const { container } = render(<Markdown text={'See `src/x.ts:12`, US-243 and ZZ-9.'} linkContext={ctx} />)
  expect(screen.getByRole('link', { name: 'src/x.ts:12' }).getAttribute('href')).toBe(
    `https://github.com/FinTekkers/horizon/blob/${HZ_SHA}/src/x.ts#L12`,
  )
  expect(screen.getByRole('link', { name: 'US-243' }).getAttribute('href')).toBe('/horizon/us-243')
  expect(screen.queryByRole('link', { name: 'ZZ-9' })).toBeNull()
  expect(container.textContent).toContain('ZZ-9.')
})

test('the same bare path on a Plan stays a plain code span', () => {
  render(<Markdown text={'See `src/x.ts:12`.'} linkContext={contextFor('plan')} />)
  expect(screen.queryByRole('link')).toBeNull()
})

test('a known id links once in a list item and in a GFM table cell', () => {
  const text = ['- in a list: US-243', '- **bold US-243**', '', '| a | b |', '| - | - |', '| US-243 | x |'].join('\n')
  const { container } = render(<Markdown text={text} linkContext={contextFor('plan', { knownIds: new Set(['US-243']) })} />)
  const items = container.querySelectorAll('li')
  expect(within(items[0]).getAllByRole('link', { name: 'US-243' })).toHaveLength(1)
  expect(within(items[1]).getAllByRole('link', { name: 'US-243' })).toHaveLength(1)
  const table = [...container.querySelectorAll('p')].find((p) => p.textContent.startsWith('| a | b |'))
  expect(within(table).getAllByRole('link', { name: 'US-243' })).toHaveLength(1)
  expect(screen.getAllByRole('link')).toHaveLength(3)
})

test('an id inside an explicit link is not linked again', () => {
  const { container } = render(
    <Markdown text={'[US-243](https://example.com/x) and [`ui-service:src/x.ts:1`](https://example.com/y)'} linkContext={contextFor('plan', { knownIds: new Set(['US-243']) })} />,
  )
  const links = screen.getAllByRole('link')
  expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/x', 'https://example.com/y'])
  expect(container.querySelectorAll('a a')).toHaveLength(0)
})

test('a code span that is only a known id links; one with more text does not', () => {
  render(<Markdown text={'`US-243` and `US-243 foo`'} linkContext={contextFor('plan', { knownIds: new Set(['US-243']) })} />)
  expect(screen.getAllByRole('link')).toHaveLength(1)
  expect(screen.getByRole('link', { name: 'US-243' }).getAttribute('href')).toBe('/horizon/us-243')
})

test('HTML in a reference label renders as text, never as an element', () => {
  const { container } = render(
    <Markdown text={'`ui-service:a/<img src=x onerror=1>.ts:1` and `ui-service:a/<b>.ts:1`'} linkContext={contextFor('plan')} />,
  )
  expect(container.querySelector('img')).toBeNull()
  expect(container.querySelector('b')).toBeNull()
  const link = screen.getByRole('link', { name: 'ui-service:a/<b>.ts:1' })
  expect(link.getAttribute('href')).toBe(`https://github.com/FinTekkers/ui-service/blob/${UI_SHA}/a/%3Cb%3E.ts#L1`)
})

test('with a context but no recorded sha nothing links to GitHub', () => {
  render(<Markdown text={'`ui-service:src/x.ts:1` and `src/x.ts:2`'} linkContext={contextFor('noShas')} />)
  expect(screen.queryByRole('link')).toBeNull()
})
