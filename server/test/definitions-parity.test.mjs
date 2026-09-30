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

// HZ-125: personas are agent-scoped, so `agent` selects the bucket and both
// sides have to agree on it as well as on the id. The fixtures cover each
// agent's bucket, the cross-agent fallback, and the no-persona roles.
const FIXTURES = [
  { role: 'eng_implement', agent: 'eng', persona: 'fullstack', project: 'FinTekkers', repo: 'FinTekkers/ui-service' },
  { role: 'eng_implement', agent: 'eng', persona: 'performance', project: 'FinTekkers', repo: 'FinTekkers/ui-service' },
  { role: 'qa', agent: 'qa', persona: 'data_integrity', project: 'FinTekkers', repo: 'FinTekkers/ledger-models' },
  { role: 'qa_review', agent: 'qa', persona: 'e2e_journey', project: 'FinTekkers', repo: null },
  { role: 'architect_review', agent: 'architect', persona: 'distributed_systems', project: 'Horizon', repo: null },
  { role: 'pm', agent: 'pm', persona: 'feature_development', project: 'Horizon', repo: null },
  { role: 'eng_implement', agent: 'eng', persona: 'ui', project: 'FinTekkers', repo: null }, // planning: no repo yet
  { role: 'eng_implement', agent: 'eng', persona: 'nonsense-id', project: 'No Such Project', repo: 'acme/none' }, // all fallbacks
  { role: 'qa', agent: 'qa', persona: 'python', project: 'FinTekkers', repo: null }, // wrong bucket -> qa default
  { role: 'eng_implement', agent: 'eng', persona: 'python_backend', project: 'FinTekkers', repo: null }, // legacy flat id
  { role: 'eng_implement', agent: 'devops', persona: 'fullstack', project: 'FinTekkers', repo: null }, // unknown agent -> bare role
  { role: 'devops', agent: 'eng', persona: null, project: 'Horizon', repo: 'FinTekkers/horizon' }, // HZ-22: direct-to-EC2 topology
  { role: 'devops', agent: 'eng', persona: null, project: 'FinTekkers', repo: 'FinTekkers/ui-service' }, // HZ-22: LB + RDS topology
]

function pythonEffectivePrompt({ role, agent, persona, project, repo }) {
  const script = [
    'import json, sys',
    'from pathlib import Path',
    'from farm.rules import effective_prompt',
    'args = json.loads(sys.argv[1])',
    "role_text = (Path('farm/roles') / (args['role'] + '.md')).read_text()",
    "sys.stdout.write(effective_prompt(role_text, args['agent'], args['persona'], args['project'], args['repo']))",
  ].join('\n')
  return execFileSync('python3', ['-c', script, JSON.stringify({ role, agent, persona, project, repo })], {
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
