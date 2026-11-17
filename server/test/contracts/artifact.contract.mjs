// HO-873: the shared Artifact port contract. Every backend adapter that
// forRepo(repo).artifacts can hand out runs this same suite, against a fake of
// its own storage. It is a helper, not a test file: `npm test` globs
// test/*.test.mjs only, so this runs only when an adapter's own test file calls
// runArtifactContract(). The port itself is written down in
// server/src/backends/artifact.js.
//
// The server never publishes: the farm does. So the publish step is not a port
// method but a harness fixture, `seed`, that each adapter's test provides.
//
// makeHarness() is called once per case and returns:
//   artifacts               the adapter under test
//   repo                    a repo the adapter may act on
//   item(state)             a new item on `repo`, 'open' or 'closed', known to
//                           the backend's item store: { id, repo }
//   seed(item, publish)     publishes { results, files } for the item, as the
//                           farm would. `files` is a Map of path → Buffer, each
//                           path under SCREENSHOT_DIR.
//   baseline()              the repo's baseline as a Map of path → Buffer, or
//                           null when it has none
//   pruneIntervalMs         how often pruneArtifacts may run
//   restore()               undoes everything the harness changed, including
//                           the record of the last prune
//   violations()            (optional) problems the harness saw; must be []
//                           after every case
//
// runArtifactContract returns the names of the cases it registered, so the
// caller can check none was skipped.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ARTIFACT_METHODS, SCREENSHOT_DIR } from '../../src/backends/artifact.js'

export { ARTIFACT_METHODS }

const quietLog = { info() {}, warn() {}, error() {}, debug() {} }

const shot = (name) => `${SCREENSHOT_DIR}/${name}.png`
const bytes = (label) => Buffer.from(`png:${label}`)

// A publish with one new shot per name.
function publishOf(names, extra = {}) {
  return {
    results: { baseline: null, shots: names.map((name) => ({ name, status: 'new' })), ...extra },
    files: new Map(names.map((name) => [shot(name), bytes(name)])),
  }
}

const sameId = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const listed = (ids, item) => ids.some((id) => sameId(id, item.id))

function assertPort(artifacts) {
  for (const method of ARTIFACT_METHODS) assert.equal(typeof artifacts[method], 'function', `the adapter has ${method}`)
}

export function runArtifactContract(name, makeHarness) {
  const names = []
  const contractCase = (caseName, title, body) => {
    names.push(caseName)
    test(`artifact contract (${name}): ${caseName}: ${title}`, async () => {
      const harness = await makeHarness()
      try {
        assertPort(harness.artifacts)
        await body(harness)
        assert.deepEqual(harness.violations?.() ?? [], [], 'the harness saw no unexpected call')
      } finally {
        await harness.restore()
      }
    })
  }

  contractCase('read', 'reads back the seeded results and every file’s bytes; an unseeded item reads null', async (h) => {
    const item = h.item('open')
    const publish = publishOf(['home', 'about'])
    await h.seed(item, publish)
    const snapshot = await h.artifacts.readArtifacts(item)
    assert.ok(snapshot, 'a seeded item has a publish')
    assert.deepEqual(snapshot.results, publish.results)
    assert.ok(snapshot.files instanceof Map, 'files is a Map')
    for (const [path, content] of publish.files) {
      const entry = snapshot.files.get(path)
      assert.ok(entry, `the publish lists ${path}`)
      assert.deepEqual(await h.artifacts.readArtifactBlob(item, entry.sha), content, path)
    }
    assert.equal(await h.artifacts.readArtifacts(h.item('open')), null)
  })

  contractCase('list', 'lists the seeded items and leaves out an unseeded one', async (h) => {
    const [a, b, unseeded] = [h.item('open'), h.item('open'), h.item('open')]
    await h.seed(a, publishOf(['home']))
    await h.seed(b, publishOf(['home']))
    const ids = await h.artifacts.listArtifacts(h.repo)
    assert.ok(Array.isArray(ids))
    assert.ok(listed(ids, a), `${a.id} is listed: ${ids}`)
    assert.ok(listed(ids, b), `${b.id} is listed: ${ids}`)
    assert.ok(!listed(ids, unseeded), `${unseeded.id} is not listed: ${ids}`)
  })

  contractCase('remove', 'after removeArtifacts the item reads null and is not listed; the other item is kept', async (h) => {
    const [item, other] = [h.item('open'), h.item('open')]
    await h.seed(item, publishOf(['home']))
    await h.seed(other, publishOf(['home']))
    await h.artifacts.removeArtifacts(item)
    assert.equal(await h.artifacts.readArtifacts(item), null)
    const ids = await h.artifacts.listArtifacts(h.repo)
    assert.ok(!listed(ids, item), `${item.id} is gone: ${ids}`)
    assert.ok(listed(ids, other), `${other.id} is kept: ${ids}`)
    // Best-effort: removing what is already gone does not reject.
    await h.artifacts.removeArtifacts(item)
  })

  contractCase('prune', 'drops a closed item’s publish, keeps an open one’s, and runs at most once per interval', async (h) => {
    const [open, closed] = [h.item('open'), h.item('closed')]
    await h.seed(open, publishOf(['home']))
    await h.seed(closed, publishOf(['home']))
    const t0 = Date.now()
    const result = await h.artifacts.pruneArtifacts({ log: quietLog, now: t0 })
    assert.ok(result, 'the first sweep runs')
    assert.ok(result.deleted >= 1, `deleted: ${result.deleted}`)
    assert.equal(await h.artifacts.readArtifacts(closed), null, 'the closed item’s publish is gone')
    assert.ok(await h.artifacts.readArtifacts(open), 'the open item’s publish is kept')
    assert.equal(await h.artifacts.pruneArtifacts({ log: quietLog, now: t0 + 1 }), null, 'a sweep right after is skipped')
    assert.ok(await h.artifacts.pruneArtifacts({ log: quietLog, now: t0 + h.pruneIntervalMs + 60_000 }), 'a sweep past the interval runs')
    assert.ok(await h.artifacts.readArtifacts(open), 'the open item’s publish is still kept')
  })

  contractCase('promote', 'copies only the approved shots into the baseline and removes the publish; null approvals reject', async (h) => {
    const item = h.item('open')
    const publish = publishOf(['home', 'about'])
    await h.seed(item, publish)
    const result = await h.artifacts.promoteArtifacts(item, new Set(['home']), { log: quietLog })
    assert.ok(result, 'a seeded item promotes')
    assert.equal(result.promoted, 1)
    const baseline = h.baseline()
    assert.ok(baseline, 'the repo has a baseline')
    assert.deepEqual(baseline.get(shot('home')), bytes('home'), 'the approved shot is in the baseline')
    assert.ok(!baseline.has(shot('about')), 'the unapproved shot is not')
    assert.equal(await h.artifacts.readArtifacts(item), null, 'the publish is removed')

    // Seeded first: with no publish there is nothing to promote and no reason to reject.
    const unapproved = h.item('open')
    await h.seed(unapproved, publishOf(['home']))
    await assert.rejects(() => h.artifacts.promoteArtifacts(unapproved, null, { log: quietLog }))
    assert.ok(await h.artifacts.readArtifacts(unapproved), 'a refused promotion keeps the publish')
  })

  return names
}
