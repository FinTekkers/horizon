// Boot entry: build the app (routes live in app.js), listen, start the
// orchestrator and GitHub sync loops.

import { buildApp } from './app.js'
import * as github from './github.js'
import * as orchestrator from './orchestrator.js'
import * as gateNotifier from './gateNotifier.js'
import * as caretaker from './caretaker.js'
import * as autoResolve from './autoResolve.js'
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
// HZ-270: records "caretaker would …" events for Autopilot shadow/on projects
// only; an 'off' project's items are never selected.
caretaker.init(fastify.log)
// Before polling starts, so the first tick already seeds main's head (HZ-235).
autoResolve.startAutoResolve(fastify.log)
github.startPolling(fastify.log)
