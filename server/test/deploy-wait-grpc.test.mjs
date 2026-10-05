// A grpc-health deploy target hands the Deploy step its health URL, so the
// farm gates the deploy on gRPC health instead of loading a web page.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'horizon-deploy-wait-grpc-'))
process.env.HORIZON_DB = join(home, 'test.db')

const { useDeployTargetRows } = await import('./helpers/deployTargetRows.mjs')
await useDeployTargetRows([
  { key: 'grpc-svc', repo: 'acme/grpc-svc', script: 'deploy-grpc.sh', service: 'grpc-svc', stateKey: 'grpc-svc', healthUrl: 'http://127.0.0.1:8090/', healthCheckType: 'grpc-health' },
  { key: 'web-svc', repo: 'acme/web-svc', script: 'deploy-web.sh', service: 'web-svc', stateKey: 'web-svc', healthUrl: 'https://web.example/', healthCheckType: 'ssr-asset-check' },
])
const { deployWaitFor } = await import('../src/deployWait.js')

test('a grpc-health target carries its health URL and type', () => {
  const wait = deployWaitFor('acme/grpc-svc')
  assert.equal(wait.health_check_type, 'grpc-health')
  assert.equal(wait.health_url, 'http://127.0.0.1:8090/')
  assert.ok(wait.state_dir.endsWith('grpc-svc'))
})

test('a web target carries only the state dir and bound, as before', () => {
  assert.deepEqual(Object.keys(deployWaitFor('acme/web-svc')).sort(), ['state_dir', 'timeout_s'])
})
