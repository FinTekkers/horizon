// Boot entry: build the app (routes live in app.js), listen, start the
// orchestrator and GitHub sync loops.

import { buildApp } from './app.js'
import * as github from './github.js'
import * as orchestrator from './orchestrator.js'
import * as gateNotifier from './gateNotifier.js'
import { PORT } from './config.js'

const fastify = buildApp()

try {
  await fastify.listen({ port: PORT })
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}

orchestrator.init(fastify.log)
// After the orchestrator, so boot-time re-dispatches have already settled the
// cursors this reads. A no-op unless WA_NOTIFY_ENABLED=1 (HZ-141).
gateNotifier.init(fastify.log)
github.startPolling(fastify.log)
