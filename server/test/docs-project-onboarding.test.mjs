// HZ-400: docs/project-onboarding.md, the guide for onboarding a new project.
// These tests keep it whole and keep it true:
//   - the nine steps, in the outcome's order, each with its four labelled
//     parts, after a "Before you start" section; docs/README.md links it;
//   - drift: every UI label or route it names (written as bold code,
//     **`Like this`**) still appears in ui/src, outside comments;
//   - every Known gaps label is still ABSENT from ui/src, so a gap that ships
//     fails here until the guide is updated;
//   - every linked screenshot exists, and every Admin step links one;
//   - no secrets in the text;
//   - the committed screenshots can never be rewritten by a normal e2e run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, repoFiles } from './helpers/repoFiles.mjs'

const DOCS = path.join(REPO_ROOT, 'docs')
const DOC_PATH = path.join(DOCS, 'project-onboarding.md')
const UI_SRC = path.join(REPO_ROOT, 'ui', 'src')

// The outcome's steps, in order (HZ-400), with the HZ references dropped.
const STEP_TITLES = [
  'Create the project',
  'Connect its repos; the webhook is created and verified',
  'Set the check commands',
  'Set the project and repo rules',
  'Set up deploy targets and do a Dry run',
  'Choose the provider/model defaults',
  'Run the Validate project pre-flight',
  'Enable the project, and decide on Autopilot',
  'File and watch a first small item',
]
const PART_LABELS = ['What to enter:', 'Where:', 'Done when:', 'If it fails:']
// The admin screens: a step whose Where: names one must show it.
const ADMIN_ROUTES = ['/admin', '/definitions']

const doc = () => readFileSync(DOC_PATH, 'utf8')

// Level-2 sections, in order: { heading, body }. Fenced code is skipped so a
// '## ' inside a code block is not a heading.
function sections(md) {
  const out = []
  let fenced = false
  for (const line of md.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced
    const m = !fenced && /^## (.+)$/.exec(line)
    if (m) out.push({ heading: m[1].trim(), body: '' })
    else if (out.length) out[out.length - 1].body += `${line}\n`
  }
  return out
}

function stepHeadings(md) {
  return sections(md)
    .map((s) => /^(\d+)\. (.+)$/.exec(s.heading))
    .filter(Boolean)
    .map((m) => ({ n: Number(m[1]), title: m[2] }))
}

const section = (md, heading) => sections(md).filter((s) => s.heading === heading)

// Bold code, **`Like this`**: the doc's convention for a UI label or route.
const boldCode = (text) => [...text.matchAll(/\*\*`([^`]+)`\*\*/g)].map((m) => m[1])

// Every UI name the doc relies on: bold code everywhere except Known gaps.
function uiNames(md) {
  const names = sections(md)
    .filter((s) => s.heading !== 'Known gaps')
    .flatMap((s) => boldCode(s.body))
  const intro = md.split(/^## /m)[0]
  return [...new Set([...boldCode(intro), ...names])]
}

// Each Known gaps entry leads with the label the missing control would have.
function gapNames(md) {
  const [gaps] = section(md, 'Known gaps')
  if (!gaps) return []
  return gaps.body
    .split('\n')
    .map((line) => /^- \*\*`([^`]+)`\*\*/.exec(line))
    .filter(Boolean)
    .map((m) => m[1])
}

// Blanks // and /* */ comments. Line comments go first, so a `/*` inside one
// (`farm/rules/*.md`) never opens a block. A `//` after a ':' is a URL.
function stripJsComments(text) {
  return text
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

function uiSourceText() {
  return repoFiles(UI_SRC)
    .filter((file) => /\.(js|jsx)$/.test(file) && !/\.test\.(js|jsx)$/.test(file))
    .map((file) => stripJsComments(readFileSync(file, 'utf8')))
    .join('\n')
}

// A route is matched by the exact segment literal App.jsx's parsePath tests.
function routeSegments() {
  const app = stripJsComments(readFileSync(path.join(UI_SRC, 'App.jsx'), 'utf8'))
  return new Set([...app.matchAll(/seg\.toLowerCase\(\) === '([a-z-]+)'/g)].map((m) => `/${m[1]}`))
}

// The names a source text no longer has. Routes go through routeSegments.
function missingNames(names, source, routes) {
  return names.filter((name) => (name.startsWith('/') ? !routes.has(name) : !source.includes(name)))
}

test('the nine steps are numbered headings, in the outcome order', () => {
  const steps = stepHeadings(doc())
  assert.deepEqual(
    steps,
    STEP_TITLES.map((title, i) => ({ n: i + 1, title })),
  )
})

test('every step has its four labelled parts, in order and non-empty', () => {
  const md = doc()
  for (const [i, title] of STEP_TITLES.entries()) {
    const [step] = section(md, `${i + 1}. ${title}`)
    assert.ok(step, `step ${i + 1} is missing`)
    const at = PART_LABELS.map((label) => step.body.indexOf(`**${label}**`))
    for (const [k, label] of PART_LABELS.entries()) {
      assert.ok(at[k] >= 0, `step ${i + 1} has no "${label}"`)
      if (k > 0) assert.ok(at[k] > at[k - 1], `step ${i + 1}'s "${label}" comes before "${PART_LABELS[k - 1]}"`)
      const text = step.body.slice(at[k] + label.length + 4, k + 1 < at.length ? at[k + 1] : undefined)
      assert.ok(text.trim(), `step ${i + 1}'s "${label}" is empty`)
    }
  }
})

test('docs/README.md links the guide as a list item', () => {
  const readme = readFileSync(path.join(DOCS, 'README.md'), 'utf8')
  assert.match(readme, /^- \[[^\]]+\]\(project-onboarding\.md\)/m)
})

test('Before you start comes once, before step 1, and names what to have ready', () => {
  const md = doc()
  const all = sections(md)
  const before = all.filter((s) => s.heading === 'Before you start')
  assert.equal(before.length, 1)
  assert.ok(all.indexOf(before[0]) < all.findIndex((s) => s.heading.startsWith('1. ')))
  for (const needed of ['GitHub', 'gate PIN', 'infra/host/', 'env']) {
    assert.ok(before[0].body.includes(needed), `Before you start does not name ${needed}`)
  }
})

test('the drift extractor finds the core labels', () => {
  const names = uiNames(doc())
  for (const name of ['Create project', 'Connect', 'Check commands', 'Dry run', 'Enabled', 'Autopilot', '/admin', '/definitions']) {
    assert.ok(names.includes(name), `the guide no longer names ${name} as a UI label`)
  }
})

test('every UI label and route the guide names still exists in ui/src', () => {
  const missing = missingNames(uiNames(doc()), uiSourceText(), routeSegments())
  assert.deepEqual(missing, [], `renamed or removed in ui/src — update docs/project-onboarding.md: ${missing.join(', ')}`)
})

test('the drift check ignores comments and names what is missing', () => {
  const source = stripJsComments(
    [
      "// Dry run lives here",
      '/* Deploy target overrides */',
      "{/* Check commands */}",
      "const url = 'https://example.com/x' // Autopilot",
      "const label = 'Create project'",
    ].join('\n'),
  )
  assert.deepEqual(
    missingNames(['Dry run', 'Deploy target overrides', 'Check commands', 'Autopilot', 'Create project', 'Zz Nonexistent Button'], source, new Set()),
    ['Dry run', 'Deploy target overrides', 'Check commands', 'Autopilot', 'Zz Nonexistent Button'],
  )
  assert.ok(source.includes('https://example.com/x'))
  assert.deepEqual(missingNames(['/admin', '/admins'], '', new Set(['/admin'])), ['/admins'])
})

test('routes match the exact parsePath segments in App.jsx', () => {
  const routes = routeSegments()
  assert.ok(routes.has('/admin'))
  assert.ok(routes.has('/definitions'))
})

test('each Known gaps label is still absent from ui/src, and kept out of the drift set', () => {
  const md = doc()
  const gaps = gapNames(md)
  assert.ok(gaps.includes('Validate project'), 'Validate project (HZ-248) is no longer listed as a gap')
  const source = uiSourceText()
  const shipped = gaps.filter((name) => source.includes(name))
  assert.deepEqual(shipped, [], `now in ui/src — update the step and drop it from Known gaps: ${shipped.join(', ')}`)
  const names = new Set(uiNames(md))
  assert.deepEqual(
    gaps.filter((name) => names.has(name)),
    [],
  )
})

test('every linked screenshot exists under docs/images/onboarding/', () => {
  const links = [...doc().matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1])
  assert.ok(links.length > 0)
  for (const link of links) {
    assert.match(link, /^images\/onboarding\/[\w-]+\.png$/)
    const file = path.join(DOCS, link)
    assert.ok(existsSync(file), `${link} does not exist`)
    // A PNG, not an empty or failed capture.
    const bytes = readFileSync(file)
    assert.ok(bytes.length > 1024 && bytes.subarray(1, 4).toString('latin1') === 'PNG', `${link} is not a PNG`)
  }
})

test('every step whose Where: names an Admin screen links a screenshot', () => {
  const md = doc()
  for (const [i, title] of STEP_TITLES.entries()) {
    const [step] = section(md, `${i + 1}. ${title}`)
    const where = step.body.split('**Where:**')[1]?.split(/\*\*(?:Done when|If it fails):\*\*/)[0] ?? ''
    if (!ADMIN_ROUTES.some((route) => where.includes(`**\`${route}\`**`))) continue
    assert.match(step.body, /!\[[^\]]*\]\(images\/onboarding\//, `step ${i + 1} uses an Admin screen but has no screenshot`)
  }
})

test('the guide holds no token or secret value', () => {
  const md = doc()
  assert.doesNotMatch(md, /\b(?:ghp|gho|ghs|ghu|ghr|github_pat)_/)
  assert.doesNotMatch(md, /\$?(?:GITHUB_TOKEN|GITHUB_WEBHOOK_SECRET|GOOGLE_CLIENT_SECRET|RULES_HMAC_SECRET)=\S/)
})

test('a normal e2e run can never regenerate the committed screenshots', () => {
  const config = readFileSync(path.join(REPO_ROOT, 'e2e', 'playwright.config.js'), 'utf8')
  assert.match(config, /testDir: '\.\/tests'/)
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'e2e', 'package.json'), 'utf8'))
  assert.doesNotMatch(pkg.scripts.test, /onboarding/)
  const touching = repoFiles(path.join(REPO_ROOT, 'e2e', 'tests')).filter((file) =>
    readFileSync(file, 'utf8').includes('docs/images'),
  )
  assert.deepEqual(touching, [])
})
