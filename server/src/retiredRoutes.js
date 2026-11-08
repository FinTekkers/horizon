// HZ-712: the old move routes, retired once POST /api/items/:id/move had run
// for a release (HZ-710). Every caller moves items through /move now, so each
// old route only answers 410 naming it. A stub never reads the item, writes
// nothing (no event, no move log, no feedback row) and sends nothing to the
// farm — past send-back and approve history stays as it was written.
//
// openapi.js's isRetired() reads RETIRED_MOVE_ROUTES, so the stubs stay out of
// the published document and openapi-route-coverage-derived.test.mjs agrees.

export const MOVE_ROUTE = 'POST /api/items/:id/move'

// Registered route urls, as app.js wrote them before.
export const RETIRED_MOVE_ROUTES = [
  { method: 'POST', url: '/api/items/:id/reject' },
  { method: 'POST', url: '/api/items/:id/phases/:phase/restart' },
  { method: 'POST', url: '/api/items/:id/forward-to-accept' },
  // The step key form went too: an approve is a move from the gate.
  { method: 'POST', url: '/api/items/:id/gates/:step/approve' },
]

// The one 410 body, for the stubs and for /feedback's step re-run.
export function retiredBody() {
  return { error: 'route_retired', use: MOVE_ROUTE }
}

export function sendRetired(reply) {
  return reply.code(410).send(retiredBody())
}

export function isRetired(url) {
  const path = String(url).split('?')[0]
  return RETIRED_MOVE_ROUTES.some((route) => route.url === path)
}

// Same scope as the routes they replace, so an unauthenticated call is still
// the scope hook's 401, never a 410.
export function registerRetiredMoveRoutes(fastify) {
  for (const { method, url } of RETIRED_MOVE_ROUTES) {
    fastify.route({ method, url, config: { scope: 'member:item' }, handler: (_request, reply) => sendRetired(reply) })
  }
}
