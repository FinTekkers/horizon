// HO-877: the sl land's shared words, in a leaf with no imports, so
// caretakerAccept.js (which imports nothing that can act, and no backend
// module) reads the same values backends/sl/vcs.js answers with.

// The review status a diff must have before it lands.
export const ACCEPTED = 'Accepted'

// The refusals that mean "not yet": Accept may be pressed again once the diff
// (or the gate) is Accepted, so the caretaker waits on them instead of stopping.
export const WAIT_REFUSALS = Object.freeze(['diff_not_accepted', 'gate_not_accepted'])
