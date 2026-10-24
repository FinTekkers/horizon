// HZ-580: what the owner can do about a rule block, named once. The block's
// event text (server/src/orchestrator.js), the owner's ping
// (server/src/ruleBlock.js) and the banner's buttons (ui/src/components/
// Tracker.jsx, one `data-rule-block-action={key}` each) all read this list, and
// a test on each side checks every phrase named here has a button. Phrases only:
// button labels are presentation and stay in the UI.
//
// No JSON source and no Python twin: this is copy that only JS renders, so it
// pairs with nothing in domain/*.json (see the README's Layout table).

export const RULE_BLOCK_ACTIONS = Object.freeze([
  Object.freeze({ key: 'addDependency', phrase: 'add a dependency on the item that delivers it' }),
  Object.freeze({ key: 'resume', phrase: 'resume to retry' }),
  Object.freeze({ key: 'abandon', phrase: 'abandon' }),
])

// "a, b, or c" — lower case, no full stop; callers capitalise or punctuate.
export function ruleBlockActionsText() {
  const phrases = RULE_BLOCK_ACTIONS.map((a) => a.phrase)
  return `${phrases.slice(0, -1).join(', ')}, or ${phrases[phrases.length - 1]}`
}
