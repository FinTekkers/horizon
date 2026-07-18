// Boot entry: build the app (routes live in app.js), listen, start the
// orchestrator and GitHub sync loops.

import { buildApp } from './app.js'
import * as github from './github.js'
import * as orchestrator from './orchestrator.js'
import { PORT } from './config.js'

const fastify = buildApp()

try {
  await fastify.listen({ port: PORT })
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}

orchestrator.init(fastify.log)
github.startPolling(fastify.log)
