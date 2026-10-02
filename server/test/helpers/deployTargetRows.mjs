// HZ-263: deploy targets are rows in deploy_target, so a deploy test's target
// setup is "replace the table's rows with these fixtures". The resolver
// re-validates every row against the scripts dir and its
// horizon-deploy.sudoers, so the fixtures get a stub dir holding an empty
// script per target and a sudoers file permitting each fixture's services.
//
// Call this AFTER setting HORIZON_DB: it imports deployTargets.js (and so
// db.js and the one-time seed) itself, then clears the seeded rows.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function stubScriptsDir() {
  const dir = mkdtempSync(join(tmpdir(), 'horizon-deploy-scripts-'))
  process.env.HORIZON_DEPLOY_SCRIPTS_DIR = dir
  return dir
}

const FIXTURE_DEFAULTS = {
  script: 'stub.sh',
  service: 'stub-service',
  repoDir: '/tmp/fixture',
  healthUrl: 'http://stub.invalid/',
  healthCheckType: 'json-health',
}

export async function useDeployTargetRows(targets) {
  const { db } = await import('../../src/db.js')
  await import('../../src/deployTargets.js')
  const dir = process.env.HORIZON_DEPLOY_SCRIPTS_DIR ?? stubScriptsDir()
  const rows = targets.map((target) => ({ ...FIXTURE_DEFAULTS, ...target }))
  const services = new Set()
  for (const row of rows) {
    writeFileSync(join(dir, row.script), '#!/bin/sh\n', { mode: 0o755 })
    for (const service of [row.service, ...(row.extraServices ?? [])]) services.add(service)
  }
  writeFileSync(
    join(dir, 'horizon-deploy.sudoers'),
    [...services].map((service) => `ubuntu ALL=(root) NOPASSWD: /bin/systemctl restart ${service}\n`).join(''),
  )
  const insert = db.prepare(`
    INSERT INTO deploy_target
      (key, repo, script, service, repo_dir, state_key, health_url, health_check_type, extra_services)
    VALUES (@key, @repo, @script, @service, @repoDir, @stateKey, @healthUrl, @healthCheckType, @extraServices)
  `)
  db.transaction(() => {
    db.prepare('DELETE FROM deploy_target').run()
    for (const row of rows) {
      insert.run({ ...row, extraServices: row.extraServices ? JSON.stringify(row.extraServices) : null })
    }
  })()
  return dir
}
