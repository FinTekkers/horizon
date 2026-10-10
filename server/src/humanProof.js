// HZ-384: proof that a human with the gate PIN made this request.
//
// app.js's humanAuthorized() mints one only after a browser session AND a
// valid x-human-key; store.approveGate refuses a humanOnly gate (domain/
// steps.json) without one. A proof is registered here when it is minted, so a
// look-alike object built anywhere else — `{ pinVerified: true }` — is not
// one. Only app.js may import mintHumanProof (pinned by
// task-approve-run-gate.test.mjs). No imports, so store.js can depend on this
// without pulling in auth or creating a cycle.

const minted = new WeakSet()

export function mintHumanProof({ userId }) {
  const proof = Object.freeze({ pinVerified: true, userId })
  minted.add(proof)
  return proof
}

export function isHumanProof(proof) {
  return typeof proof === 'object' && proof !== null && minted.has(proof)
}
