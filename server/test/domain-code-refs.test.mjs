// HZ-546: code references and item IDs become links.
//
// The first half runs every case pinned in domain/fixtures/code-ref-cases.json
// through domain/js/codeRefs.js — the grammar, the known-repo-plus-recorded-sha
// rule and the href safety checks (guardrails 2 and 3). The second half renders
// the server's "View full artifact" page and the step output page over HTTP:
// metric 1 on the page most long artifacts are read on, guardrail 1 (the
// stored text is never rewritten) and guardrail 4 (no reference, no change).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { marked } from 'marked'
import { loginFixtureUser } from './helpers/session.mjs'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

import { buildLinkContext, codeRefUrl, isCommitSha, parseCodeRef, splitItemIds } from '../../domain/js/codeRefs.js'

const fixture = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/fixtures/code-ref-cases.json'), 'utf8'))
const contextFor = (name) => buildLinkContext({ ...fixture.contexts[name], itemHref: (id) => `/items/${id}` })

// ---- domain/js/codeRefs.js, from the fixture ----

test('the fixture is not vacuous', () => {
  assert.ok(fixture.codeRefs.length >= 30)
  assert.ok(fixture.codeRefs.some((c) => c.url) && fixture.codeRefs.some((c) => c.url === null))
  for (const c of fixture.codeRefs) assert.ok(Object.hasOwn(fixture.contexts, c.ctx), `${c.name}: unknown context ${c.ctx}`)
})

for (const c of fixture.codeRefs) {
  test(`code ref: ${c.name}`, () => {
    assert.equal(codeRefUrl(parseCodeRef(c.text), contextFor(c.ctx)), c.url)
  })
}

for (const c of fixture.itemIds) {
  test(`item ids: ${c.name}`, () => {
    const ctx = buildLinkContext({ knownIds: new Set(c.knownIds), itemHref: (id) => `/items/${id}` })
    const expected = c.pieces.map((p) => (p.id ? { id: p.id, href: `/items/${p.id}` } : p))
    assert.deepEqual(splitItemIds(c.text, ctx), expected)
  })
}

test('every link the fixture expects is on github.com at a 40-hex sha', () => {
  for (const c of fixture.codeRefs.filter((x) => x.url)) {
    const match = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/blob\/([0-9a-f]{40})\/[^\s"<>]+#L[0-9]+(?:-L[0-9]+)?$/.exec(c.url)
    assert.ok(match, c.url)
    assert.ok(isCommitSha(match[1]))
  }
})

test('item ids never link without an itemHref', () => {
  assert.deepEqual(splitItemIds('US-243', buildLinkContext({ knownIds: ['US-243'] })), [{ text: 'US-243' }])
})

test('isCommitSha accepts a 40-hex lowercase sha only', () => {
  assert.equal(isCommitSha('a'.repeat(40)), true)
  for (const bad of ['A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), null, 40]) assert.equal(isCommitSha(bad), false, String(bad))
})

// ---- the server's pages ----

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-code-refs-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)
const get = (url) => app.inject({ method: 'GET', url, headers: { cookie } })

const UI_SHA = fixture.contexts.plan.sourceShas['FinTekkers/ui-service']
const HZ_SHA = fixture.contexts.plan.sourceShas['FinTekkers/horizon']
const ATTEMPT_1_SHA = '1'.repeat(40)
const project = store.createProject('Code refs')
for (const repo of ['FinTekkers/ui-service', 'FinTekkers/horizon']) assert.ok(store.addRepoToProject(project.id, repo).ok)

const METRIC_1 = [
  '## Inventory',
  '',
  'The handler is `ui-service:src/routes/treasuries/+page.server.ts:339-342`. Also `:342-363`, `passthrough.rs:184-197` and `npm test`.',
  '',
  '- In a list: US-243 still links.',
  '',
  '| Item | Note |',
  '| --- | --- |',
  '| US-243 | a table cell |',
  '',
  'Explicit: [US-243](https://example.com/x). Unknown: ZZ-9. Label: `ui-service:a/<img src=x onerror=1>.ts:1`.',
].join('\n')

const insertItem = (id, kind, repo = 'FinTekkers/horizon') =>
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id, repo, kind) VALUES (?, ?, 'Medium', 12, ?, ?, ?)").run(id, id, project.id, repo, kind)
const insertRun = (id, stepIndex, attempt, artifact, shas, output = null) =>
  db
    .prepare(
      "INSERT INTO step_run (item_id, step_index, attempt, agent, status, artifact, output, source_shas, ended_at) VALUES (?, ?, ?, 'Eng', 'done', ?, ?, ?, '2026-10-01 12:00:00')",
    )
    .run(id, stepIndex, attempt, artifact, output, shas && JSON.stringify(shas))

insertItem('US-243', 'change')
insertItem('PL-1', 'plan')
insertRun('PL-1', 4, 1, METRIC_1, { 'FinTekkers/ui-service': ATTEMPT_1_SHA })
insertRun('PL-1', 4, 2, METRIC_1, { 'FinTekkers/ui-service': UI_SHA, 'FinTekkers/horizon': HZ_SHA })
insertItem('CH-1', 'change')
insertRun('CH-1', 4, 1, 'Single repo: `src/x.ts:12`, and US-243.', { 'FinTekkers/horizon': HZ_SHA })
// Guardrail 4: no recorded sha and no known id anywhere in the text.
const PLAIN = '# Plain\n\n- `ui-service:src/x.ts:1` and `src/y.ts:2`\n- [a link](https://example.com) and **bold** & <b>html</b>\n\n| a | b |\n| - | - |\n| `c` | d |\n\nZZ-404 stays text.'
insertItem('CH-OLD', 'change')
insertRun('CH-OLD', 4, 1, PLAIN, null)
insertItem('CH-OUT', 'change')
insertRun('CH-OUT', 11, 1, null, null, '<script>US-243</script> & done, see US-243')

const METRIC_1_HREF = `https://github.com/FinTekkers/ui-service/blob/${UI_SHA}/src/routes/treasuries/+page.server.ts#L339-L342`
const article = (body) => /<article>([\s\S]*)<\/article>/.exec(body)[1]

test('metric 1: the artifact page links a multi-repo reference at the run’s sha, and leaves the rest as plain code', async () => {
  const res = await get('/api/items/PL-1/artifacts/4')
  assert.equal(res.statusCode, 200)
  const html = article(res.body)
  assert.ok(
    html.includes(
      `<a href="${METRIC_1_HREF}" target="_blank" rel="noopener noreferrer"><code>ui-service:src/routes/treasuries/+page.server.ts:339-342</code></a>`,
    ),
    html,
  )
  for (const plain of [':342-363', 'passthrough.rs:184-197', 'npm test']) {
    assert.ok(html.includes(`<code>${plain}</code>`), plain)
    assert.ok(!html.includes(`"><code>${plain}</code></a>`), `${plain} must not be a link`)
  }
})

test('the earlier attempt’s page links at that attempt’s own sha', async () => {
  const html = article((await get('/api/items/PL-1/artifacts/4/1')).body)
  assert.ok(html.includes(`/blob/${ATTEMPT_1_SHA}/src/routes/treasuries/+page.server.ts#L339-L342`))
  assert.ok(!html.includes(UI_SHA))
})

test('a known item id links to its Horizon page — in a paragraph, a list item and a table cell — and an unknown one stays text', async () => {
  const html = article((await get('/api/items/PL-1/artifacts/4')).body)
  const idLink = `<a href="${config.UI_URL}/us-243">US-243</a>`
  assert.ok(html.includes(`<li>In a list: ${idLink} still links.</li>`), html)
  assert.ok(html.includes(`<td>${idLink}</td>`), html)
  assert.ok(html.includes('Unknown: ZZ-9.'))
  assert.ok(!html.includes('/zz-9'))
})

test('an id already inside a link is not linked twice', async () => {
  const html = article((await get('/api/items/PL-1/artifacts/4')).body)
  assert.ok(html.includes('<a href="https://example.com/x">US-243</a>'), html)
  assert.equal(html.match(/<a [^>]*>[^<]*<a /g), null)
})

test('an id inside a raw HTML link (which the page passes through) is not linked again', async () => {
  insertRun('PL-1', 6, 1, 'Raw: <a href="https://example.com/raw">US-243 and `US-243`</a>, then US-243.', null)
  const html = article((await get('/api/items/PL-1/artifacts/6')).body)
  assert.ok(html.includes('<a href="https://example.com/raw">US-243 and <code>US-243</code></a>'), html)
  assert.ok(html.includes(`, then <a href="${config.UI_URL}/us-243">US-243</a>.`), html)
})

test('HTML in a reference label stays escaped', async () => {
  const html = article((await get('/api/items/PL-1/artifacts/4')).body)
  assert.ok(!html.includes('<img'), html)
  assert.ok(html.includes('<code>ui-service:a/&lt;img src=x onerror=1&gt;.ts:1</code>'), html)
})

test('metric 2 on the server page: a single-repo Change links a bare path against the item’s repo', async () => {
  const html = article((await get('/api/items/CH-1/artifacts/4')).body)
  assert.ok(html.includes(`<a href="https://github.com/FinTekkers/horizon/blob/${HZ_SHA}/src/x.ts#L12" target="_blank" rel="noopener noreferrer"><code>src/x.ts:12</code></a>`), html)
  assert.ok(html.includes(`<a href="${config.UI_URL}/us-243">US-243</a>`))
})

test('a Plan never links a bare path, even with a sha recorded', async () => {
  insertRun('PL-1', 5, 1, 'Bare: `src/x.ts:12`.', { 'FinTekkers/horizon': HZ_SHA })
  const html = article((await get('/api/items/PL-1/artifacts/5')).body)
  assert.ok(html.includes('<code>src/x.ts:12</code>') && !html.includes('github.com'), html)
})

test('guardrail 4: with no sha and no known id the page body is exactly marked.parse()', async () => {
  const html = article((await get('/api/items/CH-OLD/artifacts/4')).body)
  assert.equal(html, marked.parse(PLAIN))
})

test('guardrail 1: rendering never rewrites the stored artifact', async () => {
  await get('/api/items/PL-1/artifacts/4')
  await get('/api/items/PL-1/artifacts/4/1')
  const rows = db.prepare("SELECT artifact FROM step_run WHERE item_id = 'PL-1' AND step_index = 4 ORDER BY attempt").all()
  assert.deepEqual(
    rows.map((r) => r.artifact),
    [METRIC_1, METRIC_1],
  )
})

test('the step output page links known ids inside <pre> and keeps everything else escaped', async () => {
  const res = await get('/api/items/CH-OUT/steps/11/output')
  assert.equal(res.statusCode, 200)
  const pre = /<pre>([\s\S]*)<\/pre>/.exec(res.body)[1]
  const idLink = `<a href="${config.UI_URL}/us-243">US-243</a>`
  assert.equal(pre, `&lt;script&gt;${idLink}&lt;/script&gt; &amp; done, see ${idLink}`)
})

test('the item link shape is the back link’s: UI_URL plus the lowercased id', async () => {
  const res = await get('/api/items/CH-1/artifacts/4')
  assert.ok(res.body.includes(`<a href="${config.UI_URL}/ch-1">← CH-1 in Horizon</a>`))
  assert.ok(res.body.includes(`<a href="${config.UI_URL}/us-243">US-243</a>`))
})
