// HZ-711: an item's `moves` as the server serves it (server/src/moveItem.js
// movesView), from a literal the tests can read: each target written with its
// key, label and action, reapprovals by label, Approve as the gate it passes,
// Amend the rule as the target it moves to. A reapproval names a target's or
// the gate's label; any other is served under its own label as its key.
export function servedMoves({ approve = null, targets = [], canAbandon = false, amend = null }) {
  const keyOf = new Map(targets.map((t) => [t.label, t.key]))
  if (approve) keyOf.set(approve.label, approve.key)
  const labels = {}
  const named = (key, label) => {
    labels[key] = label
    return key
  }
  return {
    targets: targets.map((t) => ({
      stepKey: named(t.key, t.label),
      isDefault: t.isDefault === true,
      redo: t.redo,
      reapprovals: (t.reapprovals ?? []).map((label) => named(keyOf.get(label) ?? label, label)),
      stopsRunning: t.stopsRunning === true,
    })),
    actions: Object.fromEntries(targets.map((t) => [t.key, t.action])),
    labels: approve ? { ...labels, [approve.key]: approve.label } : labels,
    approveKey: approve?.key ?? null,
    canAbandon,
    amendKey: amend?.key ?? null,
  }
}
