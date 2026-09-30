// HZ-128 guardrail 3 and success criterion 11:
//   Guardrail 3   — "no npm workspace, no published package, no new dependency."
//   Criterion 11  — "regenerating bindings is one documented command, named in
//                    domain/README.md."
//
// The dependency lists are pinned byte-for-byte against their current values.
// That is deliberately annoying to change: guardrail 3 is the one constraint a
// future "just add ajv" would quietly break, and the hand-rolled
// domain/validate.mjs only exists because of it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

import { REPO_ROOT } from '../../domain/generate.mjs'

function readJson(relPath) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relPath), 'utf8'))
}

const root = readJson('package.json')
const serverPkg = readJson('server/package.json')
const uiPkg = readJson('ui/package.json')
const e2ePkg = readJson('e2e/package.json')

// Pinned as of HZ-128. Changing these is a deliberate act, not a side effect.
const PINNED_DEPS = {
  'server/package.json': {
    dependencies: {
      '@fastify/cookie': '^11.1.2',
      'better-sqlite3': '^12.4.1',
      fastify: '^5.6.2',
      'google-auth-library': '^11.0.0',
      marked: '^18.0.6',
      pixelmatch: '^7.2.0',
      pngjs: '^7.0.0',
    },
    devDependencies: undefined,
  },
  'ui/package.json': {
    dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
    devDependencies: {
      '@testing-library/dom': '^10.4.1',
      '@testing-library/react': '^16.3.2',
      '@vitejs/plugin-react': '^4.3.4',
      jsdom: '^29.1.1',
      vite: '^6.0.7',
      vitest: '^4.1.10',
    },
  },
  'e2e/package.json': {
    dependencies: undefined,
    devDependencies: { '@playwright/test': '^1.62.1', 'better-sqlite3': '^12.11.1' },
  },
}

// ---- guardrail 3 ----

test('no npm workspace was introduced', () => {
  assert.equal(root.workspaces, undefined, 'the root package.json declares workspaces — guardrail 3 forbids it')
  for (const [name, pkg] of [['server', serverPkg], ['ui', uiPkg], ['e2e', e2ePkg]]) {
    assert.equal(pkg.workspaces, undefined, `${name}/package.json declares workspaces`)
  }
})

test('domain/ is not a package: no package.json, no name, nothing publishable', () => {
  assert.ok(!existsSync(path.join(REPO_ROOT, 'domain/package.json')), 'domain/ has a package.json — it is consumed by relative path')
  assert.ok(!existsSync(path.join(REPO_ROOT, 'domain/node_modules')))
  assert.ok(root.private === true, 'the root package must stay private')
})

test('not one dependency was added anywhere', () => {
  for (const [relPath, pinned] of Object.entries(PINNED_DEPS)) {
    const pkg = readJson(relPath)
    assert.deepEqual(pkg.dependencies, pinned.dependencies, `${relPath} dependencies changed`)
    assert.deepEqual(pkg.devDependencies, pinned.devDependencies, `${relPath} devDependencies changed`)
  }
  assert.equal(root.dependencies, undefined, 'the root package.json grew dependencies')
  assert.equal(root.devDependencies, undefined, 'the root package.json grew devDependencies')
})

test('the hand-rolled validator is the reason no dependency was added — it exists and is self-contained', () => {
  const validator = readFileSync(path.join(REPO_ROOT, 'domain/validate.mjs'), 'utf8')
  assert.ok(!/^\s*import\s+[^\n]*from\s+'[^.]/m.test(validator), 'domain/validate.mjs imports a package — it must be dependency-free')
})

// ---- criterion 11: one documented regen command ----

test('the regen command is exactly one npm script, and it is the one the banner names', () => {
  assert.equal(root.scripts['gen:domain'], 'node domain/generate.mjs --write')
  assert.equal(serverPkg.scripts['gen:steps'], undefined, 'the superseded gen:steps script is still in server/package.json')
})

test('domain/README.md documents that one command', () => {
  const readme = readFileSync(path.join(REPO_ROOT, 'domain/README.md'), 'utf8')
  assert.match(readme, /npm run gen:domain/)
  assert.match(readme, /node domain\/generate\.mjs --check/)
  // The things a future editor most needs told, each asserted rather than hoped
  // for: edit the source not the output, the surviving duplicate, and the
  // design-system exclusion.
  assert.match(readme, /domain\/steps\.json/)
  assert.match(readme, /agentTokens\.js/)
  assert.match(readme, /design-system/)
})

// ---- the gate actually runs all of this ----

test('the root test script runs the server suite, the UI suite and the production-base UI build', () => {
  const script = root.scripts.test
  assert.match(script, /npm --prefix server test/)
  assert.match(script, /npm --prefix ui run test/)
  assert.match(script, /node ui\/scripts\/verify-base-build\.mjs/)
})

test('the production-base build verifier runs the literal command criterion 10 names', () => {
  const verifier = readFileSync(path.join(REPO_ROOT, 'ui/scripts/verify-base-build.mjs'), 'utf8')
  assert.match(verifier, /'--prefix', 'ui', 'run', 'build'/)
  assert.match(verifier, /HORIZON_BASE: '\/horizon\/'/)
  assert.match(verifier, /\/horizon\/assets\//)
})

// ---- the dev server can still serve a file from outside its root ----

test("ui/vite.config.js allows the Vite dev server to read the parent directory, where domain/ lives", () => {
  // A CONFIG-SHAPE proxy, not a dev-server boot test: booting `vite dev` and
  // fetching the module would be the real check, and this is not it. Named as a
  // proxy so nobody reads it as more than it is. `vite build` and `vitest` do
  // not consult fs.allow, so they are genuinely covered elsewhere
  // (verify-base-build.mjs and the UI suite respectively).
  const config = readFileSync(path.join(REPO_ROOT, 'ui/vite.config.js'), 'utf8')
  assert.match(config, /allow:\s*\['\.\.'\]/)
  assert.match(config, /server:\s*\{[^}]*fs[^}]*\}/)
})

test('the Python package cannot be shadowed by a stray domain.py at the repo root', () => {
  assert.ok(!existsSync(path.join(REPO_ROOT, 'domain.py')))
  // PEP 420 namespace packages: neither level carries an __init__.py, on
  // purpose — domain/ is data plus bindings, not an installable package.
  assert.ok(!existsSync(path.join(REPO_ROOT, 'domain/__init__.py')))
  assert.ok(!existsSync(path.join(REPO_ROOT, 'domain/py/__init__.py')))
})
