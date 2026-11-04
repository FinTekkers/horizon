// A tenant's Deploy step runs as the project's run user, who cannot read the
// server user's state dir (HZ-758). So once the release is live, the server
// confirms it in deploy_wait and sends the DEPLOY OK line; an internal repo's
// wait is unchanged.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'horizon-deploy-wait-tenant-'))
process.env.HORIZON_DB = join(home, 'test.db')
process.env.HOME = home

const { useDeployTargetRows } = await import('./helpers/deployTargetRows.mjs')
await useDeployTargetRows([
  { key: 'tenant-site', repo: 'acme/tenant-site', script: 'deploy-tenant-site.sh', service: '', repoDir: '/opt/tenants/tenant-site', stateKey: 'tenant-site', healthUrl: 'https://acme.example/', healthCheckType: 'deploy-log' },
  { key: 'own-tool', repo: 'acme/own-tool', script: 'deploy-own-tool.sh', service: '', repoDir: '/opt/own-tool', stateKey: 'own-tool', healthUrl: 'https://own.example/', healthCheckType: 'deploy-log' },
])
const { db } = await import('../src/db.js')
const { deployWaitFor } = await import('../src/deployWait.js')

function addProject(name, isolation, repo, prefix) {
  const id = db.prepare('INSERT INTO project (name, enabled, isolation) VALUES (?, 1, ?)').run(name, isolation).lastInsertRowid
  db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(id, repo, prefix)
}
addProject('Tenant', 'tenant', 'acme/tenant-site', 'TS')
addProject('Own', 'internal', 'acme/own-tool', 'OT')

function deployed(key, tag, commit) {
  const dir = join(home, '.horizon', key)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'last-good-tag'), `refs/tags/${tag}:${commit}\n`)
  writeFileSync(join(dir, 'self-deploy.log'), `2026-11-04T19:40:26Z DEPLOY START tag=${tag}\n2026-11-04T19:40:27Z DEPLOY OK tag=refs/tags/${tag} commit=${commit}\n`)
}

test('a tenant release that is live is confirmed, with its DEPLOY OK line', () => {
  deployed('tenant-site', 'deploy-tenant-site-b1', 'abc123')
  const wait = deployWaitFor('acme/tenant-site', { tag: 'deploy-tenant-site-b1' })
  assert.equal(wait.confirmed_live, true)
  assert.equal(wait.deploy_ok_line, '2026-11-04T19:40:27Z DEPLOY OK tag=refs/tags/deploy-tenant-site-b1 commit=abc123')
  assert.equal(wait.health_check_type, 'deploy-log')
})

test('a tenant release that is not live yet is not confirmed', () => {
  deployed('tenant-site', 'deploy-tenant-site-b1', 'abc123')
  const wait = deployWaitFor('acme/tenant-site', { tag: 'deploy-tenant-site-b10' })
  assert.equal(Object.hasOwn(wait, 'confirmed_live'), false)
  assert.equal(Object.hasOwn(wait, 'deploy_ok_line'), false)
})

test('an internal repo is never confirmed by the server, even when live', () => {
  deployed('own-tool', 'deploy-own-tool-b2', 'def456')
  const wait = deployWaitFor('acme/own-tool', { tag: 'deploy-own-tool-b2' })
  assert.deepEqual(Object.keys(wait).sort(), ['health_check_type', 'state_dir', 'timeout_s'])
})

test('with no tag, a tenant wait is unchanged', () => {
  assert.deepEqual(Object.keys(deployWaitFor('acme/tenant-site')).sort(), ['health_check_type', 'state_dir', 'timeout_s'])
})
