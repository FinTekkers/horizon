// HZ-207: each project's release deploys through its own entry in the real
// infra/host/deploy-targets.json — read only, never edited here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-multi-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-deploy-multi-home-'))
delete process.env.HORIZON_DEPLOY_TARGETS_FILE // the registry on disk

const deploy = await import('../src/deploy.js')

test('a Horizon release resolves to the horizon target and a FinTekkers release to ui-service', () => {
  assert.equal(deploy.resolveTarget('FinTekkers/horizon')?.key, 'horizon')
  assert.equal(deploy.resolveTarget('FinTekkers/ui-service')?.key, 'ui-service')
})

test("each release runs only its own target's script", () => {
  const spawned = []
  const original = deploy.runner.spawn
  deploy.runner.spawn = (target, tag) => spawned.push({ key: target.key, script: target.script, tag })
  try {
    deploy.runDeploy('FinTekkers/horizon', 'v1.0.0')
    deploy.runDeploy('FinTekkers/ui-service', 'v2.0.0')
  } finally {
    deploy.runner.spawn = original
  }
  assert.deepEqual(spawned, [
    { key: 'horizon', script: 'deploy-horizon.sh', tag: 'v1.0.0' },
    { key: 'ui-service', script: 'deploy-ui-service.sh', tag: 'v2.0.0' },
  ])
})
