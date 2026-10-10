// GitHub's spelling of a work-item kind (HZ-382), in one place: the label NAME
// github.js writes when it creates a Task's issue, and the kind-from-labels
// resolution upsertFromGithub runs when it first imports an issue. The two must
// agree, or a Task created here would import back as a change — the same
// write/read drift ./priorityLabels.js exists to prevent for priorities.
//
// The vocabulary is NOT declared here — it is ITEM_KINDS from
// domain/js/lifecycle.js, which reads domain/steps.json.
//
// Direction of dependency: store.js imports this, and github.js imports this.
// Neither is imported BY this.

import { ITEM_KINDS } from '../../domain/js/lifecycle.js'

// The label is the kind key itself: a Task's issue carries `task`.
export function kindLabelName(kind) {
  return kind
}

// Read once, at import: the first non-change kind whose label is on the issue,
// matched case-insensitively, else `change`. A re-sync never calls this — an
// item's kind is fixed when it is created.
export function kindFromLabels(labels) {
  const names = new Set((labels || []).map((label) => String(label?.name || '').toLowerCase()))
  return ITEM_KINDS.find((kind) => kind !== 'change' && names.has(kindLabelName(kind).toLowerCase())) ?? 'change'
}
