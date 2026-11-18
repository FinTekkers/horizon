// HO-877: a recording stand-in for farmd's /vcs/* routes, handed to the sl
// adapters' factories (backends/sl/review.js, backends/sl/vcs.js) as their
// farmFetch. Every request is kept; a path with no handler answers 404.
// A handler returns the JSON body or throws farmError(status, code), which is
// how orchestrator.js's farmFetch rejects for a farmd refusal.

export const LAND = '/vcs/land'
export const STATUS = '/vcs/review-status'
export const SUBMIT = '/vcs/submit'

export function farmError(status, code) {
  return Object.assign(new Error(code), { status, code })
}

export function farmdStub(handlers = {}) {
  const stub = { calls: [], handlers: { ...handlers } }
  stub.farmFetch = async (path, body, opts) => {
    stub.calls.push({ path, body: structuredClone(body), opts })
    const handler = stub.handlers[path]
    if (!handler) throw farmError(404, 'not_found')
    return handler(body)
  }
  stub.count = (path) => stub.calls.filter((c) => c.path === path).length
  stub.bodies = (path) => stub.calls.filter((c) => c.path === path).map((c) => c.body)
  return stub
}

// A 40-hex commit from one character.
export const commit = (ch) => ch.repeat(40)
