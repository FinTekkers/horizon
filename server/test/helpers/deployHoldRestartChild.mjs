// HZ-408: a "restarted server" for deploy-hold-job.test.mjs. A fresh process
// opens the same HORIZON_DB, so nothing in memory survives; it runs the
// boot-time resume at NOW with deploy spawns recorded, and prints the spawns
// and the hold rows as one JSON line.
//
// Env: HORIZON_DB, HOME, HORIZON_DEPLOY_SCRIPTS_DIR, NOW (ms).

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })

const { db } = await import('../../src/db.js')
const deploy = await import('../../src/deploy.js')
const deployQueue = await import('../../src/deployQueue.js')

const spawns = []
deploy.runner.spawn = (target, tag) => spawns.push(`${target.key}:${tag}`)

await deployQueue.resumeOnBoot(Number(process.env.NOW))

process.stdout.write(JSON.stringify({ spawns, holds: db.prepare('SELECT * FROM deploy_hold ORDER BY id').all() }) + '\n')
process.exit(0)
