// HZ-333: a "restarted server" for deploy-queue-restart.test.mjs. A fresh
// process opens the same HORIZON_DB, so nothing in memory survives; it runs
// the boot-time resume at NOW and prints what GitHub saw and the queue rows
// as one JSON line.
//
// Env: HORIZON_DB, HOME, FARM_URL, NOW (ms), STUB ({ mainSha, releases, prs }).

import { deployQueueStub } from './deployQueueStub.mjs'

const seed = JSON.parse(process.env.STUB)
const stub = deployQueueStub({ mainSha: seed.mainSha, releases: seed.releases })
for (const [key, sha] of seed.prs) stub.prs.set(key, sha)
globalThis.fetch = stub.fetch

const { db } = await import('../../src/db.js')
await import('../../src/orchestrator.js') // wires the queue's kick/fail hooks
const deployQueue = await import('../../src/deployQueue.js')

await deployQueue.resumeOnBoot(Number(process.env.NOW))

process.stdout.write(
  JSON.stringify({
    posts: stub.posts,
    releases: [...stub.releases.values()],
    dispatched: stub.dispatches.filter((d) => d.path === '/steps/run').map((d) => d.body.item.id),
    batches: db.prepare('SELECT * FROM deploy_batch ORDER BY id').all(),
    entries: db.prepare('SELECT * FROM deploy_queue_entry ORDER BY id').all(),
  }) + '\n',
)
process.exit(0)
