// HZ-128 guardrail 3, plus HZ-139's replacement for its criterion 11:
//   Guardrail 3   — "no npm workspace, no published package, no new dependency."
//   HZ-139        — there is NO regen command. Nothing is generated, so the
//                   assertions below pin its absence everywhere in the tree.
//
// The dependency lists are pinned byte-for-byte against their current values.
// That is deliberately annoying to change: guardrail 3 is the one constraint a
// future "just add ajv" would quietly break, and the hand-rolled
// domain/validate.mjs only exists because of it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

import { REPO_ROOT, filesMatching } from './helpers/repoFiles.mjs'

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
    // HZ-153 added `marked` — deliberately, as guardrail 3 intends: the item
    // allowed at most one new runtime dependency to render issue markdown on
    // the item page, and this is it. Same pin as server/ above (one markdown
    // dialect across the app), and marked has no transitive packages, so the
    // UI is still a three-dependency bundle. components/Markdown.jsx uses
    // marked.lexer() only — never marked.parse() — so no HTML sanitiser had
    // to come with it.
    dependencies: { marked: '^18.0.6', react: '^18.3.1', 'react-dom': '^18.3.1' },
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

// ---- HZ-139: there is no regen command, because nothing is generated ----
// HZ-128's criterion 11 ("regenerating bindings is one documented command")
// is retired, not weakened: the command it pinned cannot drift if it does not
// exist. These assertions keep the same shape with the opposite polarity, each
// paired with a positive control so a must-not-exist check cannot pass because
// the file read broke.

test('no regen script survives in any package.json', () => {
  assert.equal(root.scripts['gen:domain'], undefined, 'the gen:domain script is back — nothing is generated any more')
  assert.equal(serverPkg.scripts['gen:steps'], undefined, 'the superseded gen:steps script is still in server/package.json')
  // Positive control: scripts ARE being read, and the gate script is intact.
  assert.match(root.scripts.test, /npm --prefix server test/)
})

// Two files must name the deleted paths in order to assert they are gone: this
// one, and the must-not-exist list in domain-single-source.test.mjs. Every
// other file in the tree — docs, prose and comments included — must not mention
// them at all. One scan replaces remembering to update architecture.md by hand.
const MAY_NAME_THE_GENERATOR = new Set([
  'server/test/domain-no-drift-scaffolding.test.mjs',
  'server/test/domain-single-source.test.mjs',
])

test('nothing anywhere in the tree still points at the deleted generator', () => {
  const offenders = filesMatching(
    (text, rel) => !MAY_NAME_THE_GENERATOR.has(rel) && /gen:domain|generate\.mjs/.test(text),
  )
  assert.deepEqual(
    offenders,
    [],
    'these files still reference the generator HZ-139 deleted — docs included, not just code',
  )
  // Positive control: the scan DOES fire. Both exempted files really do name
  // the generator, so an exemption that stopped matching would be caught.
  const naming = filesMatching((text) => /gen:domain|generate\.mjs/.test(text))
  assert.deepEqual(naming, [...MAY_NAME_THE_GENERATOR].sort())
})

test('domain/README.md describes editing the bindings directly, and never mentions generating them', () => {
  const readme = readFileSync(path.join(REPO_ROOT, 'domain/README.md'), 'utf8')
  // \b before "generated" on purpose: the README's history paragraph names the
  // real `steps_generated.json` files HZ-128 deleted, and `_` is a word
  // character, so that filename does not trip this. Describing what was
  // removed is not describing a generation step.
  assert.doesNotMatch(readme, /gen:domain|generate\.mjs|regenerat|\bgenerated\b/i, 'the README still describes generation')
  // Positive control for the pattern itself: it DOES fire on the banner text
  // the bindings used to carry.
  assert.match('GENERATED by a generator — do not edit', /\bgenerated\b/i)
  // Positive control: the README is being read, and still tells a future editor
  // the things they most need told — edit the source not the output, the
  // surviving duplicate, and the design-system exclusion.
  assert.match(readme, /domain\/steps\.json/)
  assert.match(readme, /agentTokens\.js/)
  assert.match(readme, /design-system/)
})

// ---- the Node floor the import attribute needs ----

test('the Node floor is pinned, because the bindings use a JSON import attribute', () => {
  // `import data from '../steps.json' with { type: 'json' }` is a SYNTAX error
  // before Node 20.10. Without this pin the server would boot fine in CI and
  // fail at deploy time on an older runtime. Metadata only — no dependency, no
  // build step.
  assert.equal(root.engines?.node, '>=22')
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
  // HZ-139: it must also prove the step data was INLINED into the bundle, not
  // emitted as a separate asset that 404s under the production base. HZ-132
  // added a second probe for domain/reasons.json, reached from the UI through
  // ui/src/domain/pauseReason.js — same failure mode, different blank screen.
  assert.match(verifier, /STEPS\[0\]\.label/)
  assert.match(verifier, /REASON_IDS\[0\]/)
  assert.match(verifier, /bundled\.includes\(probe\.value\)/)
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
