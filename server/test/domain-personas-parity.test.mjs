// HZ-133 success metric 1: "persona ids, their agent, and their provider are
// declared once, in domain/."
//
// Declared once is only true if both bindings really do read the same document.
// LOAD-BEARING LEG, read this before touching the file: spawnedPython() boots a
// real python3, imports the COMMITTED domain/py/personas.py off disk, and diffs
// what that module actually produced against the JS binding — a separate
// hand-written implementation in a separate language. Do not weaken or skip it.
//
// ORDER is compared, not just membership: agent order is the picker's group
// order and the farm's provider_for() scan order, and persona order is the
// picker's option order.
//
// The second half pins the domain document to the UI's still-hand-typed
// display table. The farm and server legs that stood here compared each
// layer's registry against the binding it is built from after HZ-381
// repointed them — the document against itself — so they were deleted; the
// UI table is still hand-typed, so its leg still guards the drift it was
// written for.
//
// Modeled on domain-priorities-parity.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import {
  PERSONA_AGENTS,
  PERSONA_IDS,
  PERSONA_ROLE_FILES,
  NAMESPACED_PERSONA_IDS,
  DEFAULT_PERSONAS,
  PRIMARY_PERSONA_AGENT,
  LEGACY_PERSONA_IDS,
  isPersona,
  isPersonaAgent,
  legacyPersona,
  personaRoleFile,
} from '../../domain/js/personas.js'
import * as uiPersonas from '../../ui/src/domain/personas.js'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

function spawnedPython(expression) {
  const script = `import json; from domain.py import personas; print(json.dumps(${expression}))`
  return JSON.parse(execFileSync('python3', ['-c', script], { cwd: REPO_ROOT, encoding: 'utf8' }))
}

const source = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/personas.json'), 'utf8'))

// ---- the JS binding against the authored document ----

test('the JS binding exposes domain/personas.json verbatim, in order', () => {
  assert.ok(PERSONA_AGENTS.length > 0, 'sanity: the JS binding exports no agent')
  assert.deepEqual([...PERSONA_AGENTS], source.agents.map((entry) => entry.agent))
  for (const entry of source.agents) {
    assert.deepEqual([...PERSONA_IDS[entry.agent]], entry.personas, entry.agent)
    assert.equal(DEFAULT_PERSONAS[entry.agent], entry.default, entry.agent)
    assert.deepEqual({ ...PERSONA_ROLE_FILES[entry.agent] }, entry.roleFiles, entry.agent)
  }
  assert.equal(PRIMARY_PERSONA_AGENT, source.primaryAgent)
  assert.deepEqual(
    Object.fromEntries(Object.entries(LEGACY_PERSONA_IDS).map(([alias, pair]) => [alias, pair.join('.')])),
    source.legacyIds,
  )
})

// ---- the Python binding against the JS binding ----

test('the Python binding, imported by a real python3, exposes the same agents and ids IN THE SAME ORDER', () => {
  const python = spawnedPython(
    '{"agents": list(personas.PERSONA_AGENTS), "ids": [[a, list(ids)] for a, ids in personas.PERSONA_IDS.items()], "namespaced": list(personas.NAMESPACED_PERSONA_IDS)}',
  )
  assert.ok(python.agents.length > 0, 'sanity: the spawned Python import produced no agent')
  assert.deepEqual(python.agents, [...PERSONA_AGENTS])
  // Pairs, not an object, so key ORDER survives the JSON round trip and is compared.
  assert.deepEqual(python.ids, PERSONA_AGENTS.map((agent) => [agent, [...PERSONA_IDS[agent]]]))
  assert.deepEqual(python.namespaced, [...NAMESPACED_PERSONA_IDS])
})

test('both bindings agree on the defaults, the primary agent and the legacy aliases', () => {
  const python = spawnedPython(
    '{"defaults": list(personas.DEFAULT_PERSONAS.items()), "primary": personas.PRIMARY_PERSONA_AGENT, "legacy": [[k, list(v)] for k, v in personas.LEGACY_PERSONA_IDS.items()]}',
  )
  assert.deepEqual(python.defaults, Object.entries(DEFAULT_PERSONAS))
  assert.equal(python.primary, PRIMARY_PERSONA_AGENT)
  assert.deepEqual(python.legacy, Object.entries(LEGACY_PERSONA_IDS).map(([alias, pair]) => [alias, [...pair]]))
})

// PERSONA_PROVIDERS is Python-only — persona-to-provider is a farm routing
// concern with no JS consumer, so the JS binding validates the map but does not
// export it. The parity leg therefore reads that field from the raw document.
test('the Python persona-to-provider map equals the authored one, which ships empty (HZ-121)', () => {
  assert.deepEqual(spawnedPython('dict(personas.PERSONA_PROVIDERS)'), source.personaProviders)
  assert.deepEqual(source.personaProviders, {})
})

test('both bindings answer isPersona/is_persona identically, members, non-members and prototype keys alike', () => {
  const probes = [
    ...NAMESPACED_PERSONA_IDS.map((pair) => pair.split('.')),
    // Every id under every OTHER agent: membership is per agent.
    ...PERSONA_AGENTS.flatMap((agent) =>
      PERSONA_AGENTS.filter((other) => other !== agent).flatMap((other) => PERSONA_IDS[other].map((id) => [agent, id])),
    ),
    [PERSONA_AGENTS[0], '__proto__'],
    [PERSONA_AGENTS[0], 'hasOwnProperty'],
    [PERSONA_AGENTS[0], 'constructor'],
    ['__proto__', PERSONA_IDS[PERSONA_AGENTS[0]][0]],
    ['constructor', PERSONA_IDS[PERSONA_AGENTS[0]][0]],
    [PERSONA_AGENTS[0], ''],
    ['nope', 'nope'],
  ]
  const pythonAnswers = spawnedPython(`[personas.is_persona(a, i) for a, i in ${JSON.stringify(probes)}]`)
  assert.deepEqual(pythonAnswers, probes.map(([agent, id]) => isPersona(agent, id)))
  assert.ok(probes.some(([a, i]) => isPersona(a, i)))
  assert.ok(probes.some(([a, i]) => !isPersona(a, i)))
})

// Metric 4: every persona id resolves to a declared role file. Asserted on
// the DOMAIN binding in both languages, and against the file on disk.
test('both bindings return the same declared role filename for every persona, and that file exists in farm/roles/personas/', () => {
  const pairs = NAMESPACED_PERSONA_IDS.map((pair) => pair.split('.'))
  const js = pairs.map(([agent, id]) => personaRoleFile(agent, id))
  const python = spawnedPython(`[personas.persona_role_file(a, i) for a, i in ${JSON.stringify(pairs)}]`)
  assert.deepEqual(python, js)
  for (const [i, [agent, id]] of pairs.entries()) {
    assert.equal(js[i], source.agents.find((entry) => entry.agent === agent).roleFiles[id], `${agent}.${id}`)
    assert.ok(existsSync(path.join(REPO_ROOT, 'farm/roles/personas', js[i])), `missing role file ${js[i]}`)
  }
})

test('the legacy aliases resolve to their pre-HZ-125 meaning verbatim, in both bindings', () => {
  const expected = { python_backend: ['eng', 'python'], frontend_ui: ['eng', 'ui'], fullstack: ['eng', 'fullstack'] }
  for (const [alias, pair] of Object.entries(expected)) assert.deepEqual([...legacyPersona(alias)], pair, alias)
  for (const junk of ['eng.python', 'python', '', '__proto__', 'constructor', null, undefined]) {
    assert.equal(legacyPersona(junk), null, String(junk))
  }
  assert.deepEqual(
    spawnedPython(
      '{k: list(personas.LEGACY_PERSONA_IDS[k]) for k in ["python_backend", "frontend_ui", "fullstack"]} | {"misses": [personas.LEGACY_PERSONA_IDS.get(k) for k in ["eng.python", "python", "", "__proto__"]]}',
    ),
    { ...expected, misses: [null, null, null, null] },
  )
})

test('prototype keys are never persona agents', () => {
  for (const junk of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) assert.equal(isPersonaAgent(junk), false, junk)
})

test('the spawned Python import resolves the committed binding, reading the document from its own location', () => {
  const resolved = execFileSync(
    'python3',
    ['-c', 'from domain.py import personas; print(personas.__file__); print(personas._SOURCE_PATH)'],
    { cwd: path.join(REPO_ROOT, 'server'), env: { ...process.env, PYTHONPATH: REPO_ROOT }, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
  assert.deepEqual(resolved, [path.join(REPO_ROOT, 'domain/py/personas.py'), path.join(REPO_ROOT, 'domain/personas.json')])
})

test('the Python sequences are TUPLES and the maps read-only, so the farm cannot widen what the server enforces', () => {
  assert.deepEqual(
    spawnedPython(
      '[type(personas.PERSONA_AGENTS).__name__, sorted({type(v).__name__ for v in personas.PERSONA_IDS.values()}), type(personas.NAMESPACED_PERSONA_IDS).__name__, type(personas.PERSONA_IDS).__name__, type(personas.PERSONA_PROVIDERS).__name__, type(personas.PERSONA_ROLE_FILES).__name__, sorted({type(v).__name__ for v in personas.PERSONA_ROLE_FILES.values()})]',
    ),
    ['tuple', ['tuple'], 'tuple', 'mappingproxy', 'mappingproxy', 'mappingproxy', ['mappingproxy']],
  )
})

// ---- the domain document against the UI's hand-typed display table ----
// The UI table is the one registry HZ-381 did not repoint, so this leg still
// guards the drift it was written for — order included, because the picker
// renders Object.keys() order. (The server's display table is pinned the
// same way in server/test/domain-personas-source.test.mjs.)

test('domain/personas.json declares exactly the ids ui/src/domain/personas.js displays, in the same order', () => {
  assert.deepEqual(Object.keys(uiPersonas.PERSONAS), [...PERSONA_AGENTS])
  for (const agent of PERSONA_AGENTS) {
    assert.deepEqual(Object.keys(uiPersonas.PERSONAS[agent]), [...PERSONA_IDS[agent]], agent)
  }
})
