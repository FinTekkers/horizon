// GitHub's spelling of a work-item priority, in one place: the label NAME we
// write (`priority: critical`), the pattern that reads one back, and the
// value-from-labels resolution the issue sync runs on every webhook.
//
// HZ-135 created this file to hold three things that were previously spread
// across two layers:
//
//   1. The matching regex existed TWICE, byte-for-byte identical — as
//      PRIORITY_LABEL in server/src/store.js and PRIORITY_LABEL_RE in
//      server/src/github.js. Two names for one thing, each with its own
//      hand-typed copy of the vocabulary inside it.
//   2. priorityFromLabels() lived in store.js. Label parsing is not
//      persistence; the store owning GitHub's label syntax was hidden coupling
//      between two unrelated layers.
//   3. The name FORMAT lived in github.js's ensurePriorityLabel, a file away
//      from the pattern that has to match it. A change to one and not the other
//      is the failure mode: we would write a label the next sync could not read,
//      and the item's priority would silently revert on the following webhook.
//
// The vocabulary itself is NOT declared here — it is read from
// domain/js/priorities.js, which reads domain/priorities.json. What IS owned
// here is the GitHub-side spelling of it, which is an integration detail rather
// than domain data and so is deliberately kept out of domain/.
//
// Direction of dependency: store.js imports this, and github.js imports this.
// Neither is imported BY this, so there is no cycle to reason about.

import { PRIORITIES, DEFAULT_PRIORITY } from '../../domain/js/priorities.js'

// `priority: critical`. Lower-cased because that is the convention the labels
// were created under and changing it would orphan every existing label on every
// connected repo — HZ-135 metric 4 is that GitHub labels are unchanged.
export function priorityLabelName(priority) {
  return `priority: ${priority.toLowerCase()}`
}

// Tolerant on the way IN, exact on the way out: a human may have typed
// `priority: high`, `Priority/High`, `priority-medium` or a bare `low`, and all
// four mean the same thing. The alternation is derived from the vocabulary, so a
// value added to domain/priorities.json is readable back off an issue without a
// second edit here.
const ALTERNATION = PRIORITIES.map((value) => value.toLowerCase()).join('|')
export const PRIORITY_LABEL_RE = new RegExp(`^(?:priority\\s*[:/-]?\\s*)?(${ALTERNATION})$`, 'i')

// Folded -> the DECLARED value, so what comes back is always exactly what
// domain/priorities.json says rather than a re-capitalisation of what the label
// happened to say. This replaced a `match[1][0].toUpperCase() + rest` rebuild:
// byte-identical for today's four single-word values, but that rebuild would
// have turned a hypothetical `VeryHigh` into `Veryhigh` and failed the CHECK
// constraint the same list builds in server/src/db.js.
const BY_FOLDED_VALUE = new Map(PRIORITIES.map((value) => [value.toLowerCase(), value]))

// GitHub owns an item's priority, expressed as a label. The FIRST matching label
// wins — an issue carrying two priority labels is a human error GitHub itself
// permits, and picking the first is what the sync has always done.
export function priorityFromLabels(labels) {
  for (const label of labels || []) {
    const match = PRIORITY_LABEL_RE.exec(label?.name || '')
    if (match) return BY_FOLDED_VALUE.get(match[1].toLowerCase())
  }
  return DEFAULT_PRIORITY
}
