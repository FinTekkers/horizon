// Boot entry: build the app (routes live in app.js), listen, start the
// orchestrator and GitHub sync loops.

import { buildApp } from './app.js'
import * as github from './github.js'
import * as orchestrator from './orchestrator.js'
import * as gateNotifier from './gateNotifier.js'
import * as caretaker from './caretaker.js'
import * as caretakerActor from './caretakerActor.js'
import * as caretakerRuling from './caretakerRuling.js'
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
// HZ-271: acts on 'on'-mode decisions at gates 5, 10 and 15 through the same
// gateActions the UI routes call. Registered AFTER caretaker.init so, on any
// change, the decision row is written before this looks for it. HZ-296: the
// gate-13 pass re-reads an unknown mergeability through the existing helper.
caretakerActor.init(fastify.log, { gateActions: fastify.gateActions, refreshMergeable: github.refreshPrMergeable })
// HZ-273: rules on 'Operator must decide:' arrivals at gates 5 and 10 for
// Autopilot 'on' projects — edits only the named issue-body lines, then sends
// back with a note through the same gateActions.
caretakerRuling.init(fastify.log, { gateActions: fastify.gateActions })
// Before polling starts, so the first tick already seeds main's head (HZ-235).
autoResolve.startAutoResolve(fastify.log)
github.startPolling(fastify.log)
