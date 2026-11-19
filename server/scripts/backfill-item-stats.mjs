#!/usr/bin/env node
// HZ-921: posts the Effort & cost stats comment (server/src/statsComment.js) on
// items that closed or were abandoned before it existed — or re-checks them.
//
//   node server/scripts/backfill-item-stats.mjs --dry-run      lists each item's summary line, sends nothing
//   node server/scripts/backfill-item-stats.mjs                posts, edits or leaves each item's comment
//   node server/scripts/backfill-item-stats.mjs --item HZ-123  just that item
//   node server/scripts/backfill-item-stats.mjs --project 4    just that project's items
//
// Uses the database at HORIZON_DB, like the server. Only closed and abandoned
// items with a tracker record are touched; each tracker's upsert finds the
// existing comment by its marker, so a re-run never adds a second one. Runs
// from before HZ-921 have no num_turns: their turns read null ("not
// recorded"). Prints one JSON line per item to stdout: { id, result, line }.
// Exits 1 if any post failed.

const args = process.argv.slice(2)
const valueOf = (flag) => {
  const i = args.indexOf(flag)
  return i === -1 ? null : (args[i + 1] ?? null)
}
const dryRun = args.includes('--dry-run')
const itemId = valueOf('--item')
const project = valueOf('--project')
const projectId = project == null ? null : Number(project)
if (projectId != null && !Number.isInteger(projectId)) {
  console.error('--project takes a project id (a number)')
  process.exit(2)
}

const { backfillItemStats } = await import('../src/statsComment.js')

const log = { info: (msg) => console.error(msg), warn: (msg) => console.error(msg) }
const results = await backfillItemStats({ dryRun, itemId, projectId, log })
for (const row of results) console.log(JSON.stringify(row))
process.exit(results.some((row) => row.result === 'failed') ? 1 : 0)
