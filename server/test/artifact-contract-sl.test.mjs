// HO-878 metric 1: HO-873's shared Artifact port contract
// (test/contracts/artifact.contract.mjs) runs against the sl adapter that
// forRepo() hands out for an sl repo, with no sl-specific skip, and passes.
//
// The sl store lives under the data dir, so the database is a fresh temp file
// and the store a fresh folder beside it. The harness seeds a publish through
// the store's own write (publishArtifacts), as the farm's bundle reaches it,
// and reads the baseline straight off the disk.
//
// HO-893 metric 4: the child_process and fetch recorders go in before any
// server module loads. After every case, the harness's violations() lists any
// `git` spawn or api.github.com request made during that case, and the
// contract requires it to be empty.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runArtifactContract } from './contracts/artifact.contract.mjs'
import { installRecorders } from './helpers/noGitNoGithub.mjs'

const recorders = installRecorders()

const DATA_DIR = mkdtempSync(join(tmpdir(), 'horizon-artifact-contract-sl-'))
process.env.HORIZON_DB = join(DATA_DIR, 'test.db')
for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { forRepo, backendOf } = await import('../src/backends/index.js')
const slArtifacts = await import('../src/backends/slArtifacts.js')
const { endIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

const REPO = 'acme/sl-contract'
const PRUNE_KEY = 'sl-artifacts-prune'
const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, kind) VALUES (?, ?, ?, ?, ?, ?)')
let nextItem = 1
let nextProject = 1

// Every regular file under `dir`, as path → Buffer, without following links.
function filesUnder(dir, prefix = '') {
  const out = new Map()
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = lstatSync(full)
    if (st.isDirectory()) for (const [rel, bytes] of filesUnder(full, `${prefix}${name}/`)) out.set(rel, bytes)
    else if (st.isFile()) out.set(`${prefix}${name}`, readFileSync(full))
  }
  return out
}

function makeHarness() {
  const project = store.createProject(`sl contract ${nextProject++}`).id
  assert.equal(store.addRepoToProject(project, REPO, 'sl').ok, true)
  assert.equal(backendOf(REPO), 'sl')
  const projectDir = join(DATA_DIR, 'artifacts', `p${project}`)
  const since = recorders.mark()
  return {
    artifacts: forRepo(REPO).artifacts,
    repo: REPO,
    item(itemState) {
      const id = `SLC-${nextItem++}`
      const cursor = itemState === 'closed' ? endIndex('change') : 3
      insertItem.run(id, `${itemState} item`, 'Medium', cursor, REPO, 'change')
      return { id, repo: REPO }
    },
    async seed(item, publish) {
      await slArtifacts.publishArtifacts(item, publish)
    },
    baseline() {
      let st
      try {
        st = lstatSync(join(projectDir, 'baseline'))
      } catch {
        return null
      }
      assert.ok(st.isSymbolicLink(), 'the baseline is a link to a generation')
      const files = filesUnder(join(projectDir, 'baseline/'))
      files.delete('meta.json')
      return files
    },
    pruneIntervalMs: slArtifacts.SL_ARTIFACTS_PRUNE_MS,
    violations: () => recorders.violations(since),
    restore() {
      db.prepare('DELETE FROM work_item WHERE repo = ?').run(REPO)
      db.prepare('DELETE FROM project_repo WHERE project_id = ?').run(project)
      db.prepare('DELETE FROM project WHERE id = ?').run(project)
      db.prepare('DELETE FROM sync_cursor WHERE key = ?').run(PRUNE_KEY)
      rmSync(projectDir, { recursive: true, force: true })
    },
  }
}

test('metric 4: positive control — every child_process entry point and fetch are recorded before the contract runs', async () => {
  await recorders.selfTest()
})

const contractCases = runArtifactContract('sl', makeHarness)

test('metric 1: the contract registered every case — read, list, remove, prune and promote — for sl', () => {
  assert.ok(contractCases.length > 0)
  assert.deepEqual(contractCases, ['read', 'list', 'remove', 'prune', 'promote'])
})

test('metric 1: the contract has no skip, todo or only, so no case can be dropped for sl', () => {
  const text = readFileSync(new URL('./contracts/artifact.contract.mjs', import.meta.url), 'utf8')
  for (const banned of [/\bskip\b/, /\btodo\b/, /\.only\b/, /\bonly\s*:/]) assert.doesNotMatch(text, banned)
})

test('metric 4: across every sl contract case, zero git spawns and zero api.github.com requests', () => {
  assert.deepEqual(recorders.gitSpawns(), [])
  assert.deepEqual(recorders.githubRequests(), [])
  recorders.restore()
})
