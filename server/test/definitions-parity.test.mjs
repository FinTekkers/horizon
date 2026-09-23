// Compose-parity tripwire (architecture review note 2): the prompt
// composition exists in Python (farm/rules.py effective_prompt — what agents
// actually receive) and JS (definitions.js effectivePrompt — what the UI
// preview shows). This runs one fixture through both and requires
// byte-identical output, modeled on test_personas.py's registry parity.
//
// Runs against the REAL farm tree (no HORIZON_FARM_DIR override), in its own
// file so the temp-fixture env of definitions.test.mjs can't leak in.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-parity-')), 'test.db')
delete process.env.HORIZON_FARM_DIR

const { effectivePrompt } = await import('../src/definitions.js')

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

const FIXTURES = [
  { role: 'eng_implement', persona: 'fullstack', project: 'FinTekkers', repo: 'FinTekkers/ui-service' },
  { role: 'qa', persona: 'python_backend', project: 'FinTekkers', repo: 'FinTekkers/ledger-models' },
  { role: 'eng_implement', persona: 'frontend_ui', project: 'FinTekkers', repo: null }, // planning: no repo yet
  { role: 'eng_implement', persona: 'nonsense-id', project: 'No Such Project', repo: 'acme/none' }, // all fallbacks
  { role: 'devops', persona: null, project: 'Horizon', repo: 'FinTekkers/horizon' }, // HZ-22: direct-to-EC2 topology
  { role: 'devops', persona: null, project: 'FinTekkers', repo: 'FinTekkers/ui-service' }, // HZ-22: LB + RDS topology
]

function pythonEffectivePrompt({ role, persona, project, repo }) {
  const script = [
    'import json, sys',
    'from pathlib import Path',
    'from farm.rules import effective_prompt',
    'args = json.loads(sys.argv[1])',
    "role_text = (Path('farm/roles') / (args['role'] + '.md')).read_text()",
    "sys.stdout.write(effective_prompt(role_text, args['persona'], args['project'], args['repo']))",
  ].join('\n')
  return execFileSync('python3', ['-c', script, JSON.stringify({ role, persona, project, repo })], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
}

test('Python effective_prompt and JS effectivePrompt are byte-identical', () => {
  for (const fixture of FIXTURES) {
    const js = effectivePrompt(fixture)
    const py = pythonEffectivePrompt(fixture)
    assert.equal(js, py, `compose drift for ${JSON.stringify(fixture)}`)
  }
})
