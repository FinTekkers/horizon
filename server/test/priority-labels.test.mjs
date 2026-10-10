// HZ-135 success metric 4: "GitHub priority labels are unchanged."
//
// Before this change that metric had ZERO test coverage. Nothing in the repo
// exercised setPriorityLabel, ensurePriorityLabel or priorityFromLabels: every
// upsertFromGithub call in store.test.mjs and webhook-issue-ingest.test.mjs
// passes `labels: []`, so the label pattern had never been run against a label,
// and server/test/app.test.mjs's one adjacent case only asserts that the labels
// URL was hit — never the label's name or its colour.
//
// HZ-135 rewires exactly that path: it deletes one of the two byte-identical
// copies of the label pattern, moves the survivor plus the name format into
// server/src/priorityLabels.js, and rebuilds the colour map to key off PRIORITY.
// A `.source` string pin is not behaviour — it passes happily while
// priorityFromLabels returns the wrong case, or while the label we WRITE stops
// being one we can READ. So this file drives the real functions:
//
//   - priorityFromLabels through the real store.upsertFromGithub, so the value
//     that lands in the database is what is asserted, not an intermediate.
//   - setPriorityLabel against a stubbed global fetch, asserting the exact
//     request bodies and URLs, including the stale-label DELETE.
//
// domain-priority-pins.test.mjs holds the hand-typed expectations (the name
// format, every hex, the round trip). This file proves the code PATHS run.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-prio-labels-')), 'test.db')
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const github = await import('../src/github.js')
const { setSetting } = await import('../src/settings.js')
const { PRIORITIES, DEFAULT_PRIORITY } = await import('../../domain/js/priorities.js')
const { priorityLabelName } = await import('../src/priorityLabels.js')

const REPO = 'acme/label-fixture-repo'
store.purgeDemoItems()
setSetting('github_token', 'test-token')
const project = store.createProject('Priority labels')
assert.ok(project.ok, `fixture project must be created cleanly: ${JSON.stringify(project)}`)
const connected = store.addRepoToProject(project.id, REPO)
assert.ok(connected.ok, `fixture repo must connect cleanly: ${JSON.stringify(connected)}`)

// ---- metric 4, leg 1: reading a priority back off an issue's labels ----
//
// Driven through store.upsertFromGithub, which is what both the webhook handler
// and the poller call. The assertion is the STORED value, so nothing between the
// label and the database can quietly re-case it.

let nextIssue = 1000

function ingest(labels) {
  const number = nextIssue++
  const ok = store.upsertFromGithub(
    {
      number,
      title: `Issue #${number}`,
      body: 'An outcome.\n\n## Success metric\nA metric.\n',
      state: 'open',
      labels,
    },
    REPO,
  )
  assert.ok(ok !== false, 'upsertFromGithub refused the issue — the fixture repo is not connected')
  return db.prepare('SELECT priority FROM work_item WHERE repo = ? AND issue = ?').get(REPO, number).priority
}

// Every shape the pattern's optional prefix and optional separator permit,
// generated from each declared value rather than hand-typed as a table. Broader
// than a fixed matrix — it is every spelling × every value — and it declares no
// vocabulary, so domain-priority-literals.test.mjs needs no exemption for this
// file. domain-priority-pins.test.mjs owns the hand-typed spelling pin.
function spellingsOf(value) {
  const lower = value.toLowerCase()
  return [
    `priority: ${lower}`,
    `priority:${lower}`,
    `priority: ${value}`,
    `Priority/${value}`,
    `priority/${lower}`,
    `priority-${lower}`,
    `priority ${lower}`,
    `PRIORITY: ${value.toUpperCase()}`,
    lower,
    value,
  ]
}

test('every label spelling a human might use resolves to the declared value, for every value', () => {
  for (const value of PRIORITIES) {
    for (const label of spellingsOf(value)) {
      assert.equal(ingest([{ name: label }]), value, `label "${label}" stored the wrong priority`)
    }
  }
})

test('a label that is not a priority falls through to the default, and so does no label at all', () => {
  assert.equal(ingest([{ name: 'priority: urgent' }]), DEFAULT_PRIORITY)
  assert.equal(ingest([{ name: 'bug' }, { name: 'needs-triage' }]), DEFAULT_PRIORITY)
  assert.equal(ingest([]), DEFAULT_PRIORITY)
  assert.equal(ingest(undefined), DEFAULT_PRIORITY)
})

test('a non-priority label alongside a priority one is skipped, not treated as a match', () => {
  const some = PRIORITIES[1]
  const label = priorityLabelName(some)
  assert.equal(ingest([{ name: 'bug' }, { name: label }]), some)
  assert.equal(ingest([{ name: label }, { name: 'bug' }]), some)
})

test('a malformed label entry cannot crash the sync', () => {
  // GitHub has sent label objects without a name before; the sync must fall back
  // rather than throw mid-webhook.
  const some = PRIORITIES.at(-1)
  assert.equal(ingest([{}, null, { name: null }, { name: priorityLabelName(some) }]), some)
})

test('EVERY declared priority is readable back off a label we would have written', () => {
  // Derived, so a value added to domain/priorities.json is covered here without an
  // edit — and fails loudly if its label cannot be read back.
  for (const value of PRIORITIES) {
    assert.equal(ingest([{ name: priorityLabelName(value) }]), value, `${value} does not survive the round trip`)
  }
})

// ---- metric 4, leg 2: writing the label ----
//
// A stubbed global fetch, recording every request. This is the only thing that
// actually proves the POST body — the name AND the colour — is unchanged.

let calls = []
let realFetch

beforeEach(() => {
  calls = []
  realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body })
    // The labels-on-issue GET returns whatever the case set up; everything else
    // is a plain 200.
    if (/\/issues\/\d+\/labels$/.test(String(url)) && (opts.method || 'GET') === 'GET') {
      return { ok: true, status: 200, json: async () => currentLabels, text: async () => '' }
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
})

let currentLabels = []

const item = { repo: REPO, issue: 42 }

function labelCreate() {
  return calls.find((c) => c.method === 'POST' && c.url.endsWith(`/repos/${REPO}/labels`))
}

// The EXACT body, for every declared value. The split with
// domain-priority-pins.test.mjs is deliberate and neither half is a tautology:
// that file asserts PRIORITY_LABEL_COLORS still equals the hand-typed hex it
// carried before HZ-135, and this one asserts the POST body actually carries that
// map's value — which is the half a hand-typed expectation here could not prove,
// because a body built from some other map would still match it.
for (const value of PRIORITIES) {
  test(`setPriorityLabel(${value}) creates the label with its declared name and colour`, async () => {
    currentLabels = []
    await github.setPriorityLabel(item, value)
    const created = labelCreate()
    assert.ok(created, 'no label-create request was made')
    assert.deepEqual(JSON.parse(created.body), {
      name: priorityLabelName(value),
      color: github.PRIORITY_LABEL_COLORS[value],
    })
    // Not a hole for a missing key: an absent colour would fall back to grey and
    // still deepEqual above, so the map is required to carry this value.
    assert.match(github.PRIORITY_LABEL_COLORS[value] ?? '', /^[0-9A-F]{6}$/, `no label colour declared for ${value}`)
  })
}

test('the new label is then added to the issue', async () => {
  currentLabels = []
  const target = PRIORITIES[1]
  await github.setPriorityLabel(item, target)
  const add = calls.find((c) => c.method === 'POST' && c.url.endsWith(`/issues/42/labels`))
  assert.ok(add, 'the label was never added to the issue')
  assert.deepEqual(JSON.parse(add.body), { labels: [priorityLabelName(target)] })
})

test('a stale priority label is deleted, and an unrelated label is left alone', async () => {
  const stale = priorityLabelName(PRIORITIES.at(-1))
  currentLabels = [{ name: stale }, { name: 'bug' }, { name: 'needs-triage' }]
  await github.setPriorityLabel(item, PRIORITIES[1])
  const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.url)
  assert.deepEqual(
    deletes,
    [`https://api.github.com/repos/${REPO}/issues/42/labels/${encodeURIComponent(stale)}`],
    'the wrong set of labels was deleted',
  )
})

test('the label being set is NOT deleted when it is already present', async () => {
  const target = PRIORITIES[1]
  currentLabels = [{ name: priorityLabelName(target) }]
  await github.setPriorityLabel(item, target)
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE'), [])
})

test('an unknown priority still gets the grey fallback colour rather than none', async () => {
  // PRIORITY_LABEL_COLORS[x] || '8C8C8E'. Unreachable through the API's enums
  // today, but setPriorityLabel is exported and the fallback is real.
  currentLabels = []
  await github.setPriorityLabel(item, 'Urgent')
  assert.deepEqual(JSON.parse(labelCreate().body), { name: 'priority: urgent', color: '8C8C8E' })
})

test('a label-create failure that is not 422 abandons the mirror without throwing past the caller', async () => {
  currentLabels = []
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body })
    if (String(url).endsWith(`/repos/${REPO}/labels`)) return { ok: false, status: 500, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => [], text: async () => '' }
  }
  await assert.rejects(
    () => github.setPriorityLabel(item, PRIORITIES[1]),
    /could not ensure the priority label exists/,
  )
})

test('a 422 on label-create means "already exists" and the mirror proceeds', async () => {
  currentLabels = []
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body })
    if (String(url).endsWith(`/repos/${REPO}/labels`) && (opts.method || 'GET') === 'POST') {
      return { ok: false, status: 422, json: async () => ({}) }
    }
    return { ok: true, status: 200, json: async () => [], text: async () => '' }
  }
  const target = PRIORITIES[2]
  await github.setPriorityLabel(item, target)
  const add = calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues/42/labels'))
  assert.deepEqual(JSON.parse(add.body), { labels: [priorityLabelName(target)] })
})

// ---- HZ-382: createIssue's labels for a Task vs a change ----

function issueCreate() {
  return calls.find((c) => c.method === 'POST' && c.url.endsWith(`/repos/${REPO}/issues`))
}
const labelCreates = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith(`/repos/${REPO}/labels`))
const ISSUE = { title: 'T', outcome: 'An outcome.', metric: 'A metric.', guardrails: '', priority: DEFAULT_PRIORITY }

test('a change issue is created exactly as before: one priority label, no `task` label call', async () => {
  await github.createIssue(REPO, ISSUE)
  assert.deepEqual(labelCreates().map((c) => JSON.parse(c.body).name), [priorityLabelName(DEFAULT_PRIORITY)])
  assert.deepEqual(JSON.parse(issueCreate().body).labels, [priorityLabelName(DEFAULT_PRIORITY)])
})

test('a Task issue ensures the `task` label and carries it alongside the priority label', async () => {
  await github.createIssue(REPO, { ...ISSUE, kind: 'task' })
  assert.ok(labelCreates().some((c) => JSON.parse(c.body).name === 'task'), 'the task label was never ensured')
  assert.deepEqual(JSON.parse(issueCreate().body).labels, [priorityLabelName(DEFAULT_PRIORITY), 'task'])
})
