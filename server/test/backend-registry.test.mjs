// HO-870: the backend registry. forRepo(repo) hands a GitHub repo — and any
// repo it cannot place — the very functions github.js exports; an sl repo gets
// adapters that throw rather than fall back to GitHub. Only the call-site
// files HO-871 moved onto it import the registry from outside
// server/src/backends/, and store.js / db.js import only the leaf
// backends/names.js.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-backend-registry-')), 'test.db')
for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO']) delete process.env[key]

const store = await import('../src/store.js')
const github = await import('../src/github.js')
const { forRepo, forKind, setBackendForTest, backendOf } = await import('../src/backends/index.js')
const { githubAdapters } = await import('../src/backends/github.js')
const { ARTIFACT_METHODS } = await import('../src/backends/artifact.js')

store.purgeDemoItems()

const GROUPS = ['tracker', 'review', 'vcs', 'artifacts']
const project = store.createProject('Registry').id
assert.equal(store.addRepoToProject(project, 'acme/default').ok, true)
assert.equal(store.addRepoToProject(project, 'acme/sl-app', 'sl').ok, true)

function assertGithub(adapters, label) {
  assert.deepEqual(Object.keys(adapters), GROUPS, label)
  assert.equal(adapters, githubAdapters, label)
  for (const group of GROUPS) {
    const names = Object.keys(adapters[group])
    assert.ok(names.length > 0, `${label}: ${group} has methods`)
    for (const name of names) {
      assert.equal(typeof github[name], 'function', `${label}: github.js exports ${name}`)
      assert.equal(adapters[group][name], github[name], `${label}: ${group}.${name} is github.js's own function`)
    }
  }
}

test('metric 2: forRepo returns the github.js functions for an unknown repo, a repo with the default backend, null and undefined', () => {
  for (const [label, repo] of [
    ['unknown repo', 'acme/never-connected'],
    ['default-backend repo', 'acme/default'],
    ['default-backend repo, other case', 'ACME/Default'],
    ['null', null],
    ['undefined', undefined],
  ]) {
    assert.equal(backendOf(repo), 'github', label)
    assertGithub(forRepo(repo), label)
  }
})

// HO-878 (owner ruling): the sl artifacts group's six Artifact port methods
// are real (the sl file store); every other sl method is still a placeholder.
// The placeholders keep the HO-870 assertions; the port methods are checked
// for the port's shape and for not being GitHub's.
const isPortMethod = (group, name) => group === 'artifacts' && ARTIFACT_METHODS.includes(name)

test('an sl repo gets adapters with the same shape; every method but the six Artifact port methods throws backend_not_implemented', () => {
  assert.equal(backendOf('acme/sl-app'), 'sl')
  const sl = forRepo('acme/sl-app')
  assert.deepEqual(Object.keys(sl), GROUPS)
  let placeholders = 0
  for (const group of GROUPS) {
    assert.deepEqual(Object.keys(sl[group]), Object.keys(githubAdapters[group]), group)
    for (const [name, fn] of Object.entries(sl[group])) {
      assert.notEqual(fn, github[name], `${group}.${name} is not GitHub's`)
      if (isPortMethod(group, name)) continue
      placeholders++
      assert.throws(() => fn('acme/sl-app'), /backend_not_implemented: sl/, `${group}.${name}`)
    }
  }
  assert.ok(placeholders > 0, 'the still-placeholder methods were checked')
  assert.ok(Object.keys(sl.artifacts).some((name) => !ARTIFACT_METHODS.includes(name)), 'the artifacts group still has non-port helpers, and they throw')
})

test('HO-878: the sl artifacts group carries the six Artifact port methods as real functions with the port shape, none of them GitHub’s', async () => {
  const artifacts = forRepo('acme/sl-app').artifacts
  for (const name of ARTIFACT_METHODS) {
    const fn = artifacts[name]
    assert.equal(typeof fn, 'function', `artifacts.${name} is a function`)
    assert.notEqual(fn, github[name], `artifacts.${name} is not GitHub's`)
    assert.notEqual(fn, githubAdapters.artifacts[name], `artifacts.${name} is not the GitHub adapter's`)
    assert.equal(fn.length, github[name].length, `artifacts.${name} takes the port's arguments`)
  }
  // Real, not a placeholder: an item with nothing stored reads null and lists nothing.
  assert.equal(await artifacts.readArtifacts({ id: 'SL-1', repo: 'acme/sl-app' }), null)
  assert.deepEqual(await artifacts.listArtifacts('acme/sl-app'), [])
})

test('forKind and setBackendForTest throw on a name that is not a backend', () => {
  for (const name of ['nope', '__proto__', 'constructor', null, undefined]) {
    assert.throws(() => forKind(name), /unknown backend/, `forKind(${name})`)
    assert.throws(() => setBackendForTest(name, githubAdapters), /unknown backend/, `setBackendForTest(${name})`)
  }
  assert.equal(forKind('github'), githubAdapters, 'a rejected setBackendForTest installs nothing')
})

// ---- guardrail 3: only the listed call sites import the registry ----
// HO-871 retired the HO-870 point-in-time check ("nothing outside backends/
// imports the registry") for this explicit list: the files whose tracker calls
// moved onto forRepo()/forKind(). A new importer must be added here on purpose.
// HO-872 added autoResolve.js and deployQueue.js: their review and vcs calls
// moved onto forRepo()/forKind() and off github.js.
// HO-873 added overlapService.js, projectValidate.js, screenshots.js and
// tokenCheck.js, the last importers of github.js outside backends/.

const REGISTRY_IMPORTERS = [
  'app.js',
  'autoResolve.js',
  'caretakerRuling.js',
  'deployQueue.js',
  'orchestrator.js',
  'overlapService.js',
  'projectValidate.js',
  'screenshots.js',
  'server.js',
  'spawn.js',
  'split.js',
  'tokenCheck.js',
]

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const BACKENDS_DIR = join(SRC, 'backends')
const REGISTRY = join(BACKENDS_DIR, 'index.js')
const NAMES = join(BACKENDS_DIR, 'names.js')

function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return jsFiles(full)
    return entry.name.endsWith('.js') ? [full] : []
  })
}

// Every relative module a file imports, statically or with import(), resolved.
function importsOf(file) {
  const source = readFileSync(file, 'utf8')
  const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(['"])(\.{1,2}\/[^'"]+)\1/gm)].map((m) => m[2])
  return specifiers.map((spec) => resolve(dirname(file), spec))
}

test('guardrail 3: outside server/src/backends/ only the listed call sites import the registry; store.js and db.js import only backends/names.js', () => {
  const files = jsFiles(SRC)
  assert.ok(files.length > 50, 'the scan sees server/src')
  const importers = files
    .filter((file) => !file.startsWith(BACKENDS_DIR) && importsOf(file).includes(REGISTRY))
    .map((file) => relative(SRC, file))
    .sort()
  assert.deepEqual(importers, REGISTRY_IMPORTERS, 'the files outside backends/ that import backends/index.js')
  for (const name of ['store.js', 'db.js']) {
    const fromBackends = importsOf(join(SRC, name)).filter((target) => target.startsWith(BACKENDS_DIR))
    assert.deepEqual(fromBackends, [NAMES], `${name} imports from backends/`)
  }
  // The leaf really is a leaf.
  assert.deepEqual(importsOf(NAMES), [])
  assert.ok(!/^\s*import\s/m.test(readFileSync(NAMES, 'utf8')), 'backends/names.js has no imports')
})
