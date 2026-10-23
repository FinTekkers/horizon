// HZ-535 metric 2: the persona layer with a project overlay composes to the
// same bytes in definitions.js composeRole and farm/personas.py compose_role,
// each loading the overlay from the same temp farm/projects/<slug>/ fixture.
//
// Runs against the REAL farm tree (no HORIZON_FARM_DIR override), like
// definitions-parity.test.mjs, so the two runtimes' project directories can be
// compared too: they only agree while server and farm share one checkout.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { DEFAULT_PERSONAS, PERSONA_IDS } from '../../domain/js/personas.js'
import { DEFAULT_PROVIDER, PROVIDERS } from '../../domain/js/providers.js'

process.env.HORIZON_DB = path.join(mkdtempSync(path.join(tmpdir(), 'horizon-project-parity-')), 'test.db')
delete process.env.HORIZON_FARM_DIR

const { composeRole, loadProjectPersonas, projectPersonaOverlay, PROJECTS_DIR } = await import('../src/definitions.js')

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const ROLE = readFileSync(path.join(REPO_ROOT, 'farm/roles/eng_implement.md'), 'utf8')

const root = mkdtempSync(path.join(tmpdir(), 'horizon-project-parity-root-'))
mkdirSync(path.join(root, 'fixture', 'personas'), { recursive: true })
writeFileSync(
  path.join(root, 'fixture', 'personas.json'),
  JSON.stringify({
    personas: [
      { id: 'quant', agent: 'eng', label: 'Quant', initials: 'QT', color: '#2E6CB2', model: PROVIDERS.find((p) => p.name === DEFAULT_PROVIDER).models[0].id, provider: DEFAULT_PROVIDER, file: 'quant.md' },
    ],
  }),
)
writeFileSync(path.join(root, 'fixture', 'personas', 'quant.md'), '# Quant\n\nPrice it before you build it — ünïcode survives too.\n')

// { agent, persona, enabled }: `enabled` is the project's switch.
const FIXTURES = [
  { agent: 'eng', persona: 'fixture:quant', enabled: true }, // the project's own persona
  { agent: 'eng', persona: '  Fixture:Quant ', enabled: true }, // trimmed and lower-cased, like a global id
  { agent: 'eng', persona: 'other:quant', enabled: true }, // another project's id -> the default
  { agent: 'eng', persona: 'fixture:quant', enabled: false }, // switch off -> the default
  { agent: 'eng', persona: PERSONA_IDS.eng[1], enabled: true }, // a global id with an overlay present
  { agent: 'qa', persona: 'fixture:quant', enabled: true }, // an eng project id under qa -> qa's default
  { agent: 'qa', persona: DEFAULT_PERSONAS.qa, enabled: true },
]

function jsLayer({ agent, persona, enabled }) {
  const overlay = enabled ? loadProjectPersonas('fixture', root) : projectPersonaOverlay({ name: 'Fixture', definitions_enabled: 0 })
  return composeRole(ROLE, agent, persona, overlay)
}

function pyLayer({ agent, persona, enabled }) {
  const script = [
    'import json, sys',
    'from pathlib import Path',
    'from farm.personas import compose_role, project_overlay',
    'a = json.loads(sys.argv[1])',
    "overlay = project_overlay({'name': 'Fixture', 'definitionsEnabled': a['enabled']}, Path(a['root']))",
    "sys.stdout.write(compose_role(a['role'], a['agent'], a['persona'], overlay))",
  ].join('\n')
  return execFileSync('python3', ['-c', script, JSON.stringify({ role: ROLE, agent, persona, enabled, root })], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
}

test('definitions.js and farm/personas.py compose the persona layer to the same bytes', () => {
  for (const fixture of FIXTURES) {
    assert.equal(jsLayer(fixture), pyLayer(fixture), `compose drift for ${JSON.stringify(fixture)}`)
  }
  // Positive control: the overlay really composed the project file.
  assert.ok(jsLayer(FIXTURES[0]).endsWith('## Your specialization\n# Quant\n\nPrice it before you build it — ünïcode survives too.\n'))
  assert.equal(jsLayer(FIXTURES[3]), composeRole(ROLE, 'eng', DEFAULT_PERSONAS.eng))
})

test('the server and the farm read the same farm/projects directory', () => {
  const farmDir = execFileSync('python3', ['-c', 'import sys; from farm.personas import PROJECTS_DIR; sys.stdout.write(str(PROJECTS_DIR.resolve()))'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  assert.equal(path.resolve(PROJECTS_DIR), farmDir)
  assert.equal(farmDir, path.join(REPO_ROOT, 'farm', 'projects'))
})
