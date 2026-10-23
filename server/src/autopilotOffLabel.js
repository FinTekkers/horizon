// GitHub's spelling of "Autopilot is off for this item" (HZ-544), in one
// place, like priorityLabels.js and kindLabels.js: the label NAME github.js
// adds or removes, and the read-back the issue sync runs on every webhook and
// poll. The label is the only stored state — work_item.autopilot_off is the
// last sync's copy of it, as `priority` is of the priority label.
//
// Direction of dependency: store.js and github.js import this. Neither is
// imported BY this.

export const AUTOPILOT_OFF_LABEL = 'autopilot-off'

// Matched case-insensitively, so a hand-typed `Autopilot-Off` counts too.
export function autopilotOffFromLabels(labels) {
  return (labels || []).some((label) => String(label?.name || '').toLowerCase() === AUTOPILOT_OFF_LABEL)
}
