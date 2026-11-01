#!/usr/bin/env node
// Runs the account purge (HZ-641, server/src/accountPurge.js) by hand.
//
//   node server/scripts/purge-cancelled.mjs --dry-run   lists what would be deleted, changes nothing
//   node server/scripts/purge-cancelled.mjs             purges now (needs ACCOUNT_PURGE=on)
//
// Uses the database at HORIZON_DB, like the server. Prints one JSON line per
// eligible user to stdout: with --dry-run { userId, eligible, counts, rows }
// (rows holds primary keys only), else { userId, counts }. Log lines go to
// stderr and carry ids, dates and counts only. Exits 1 if any user failed.

const dryRun = process.argv.slice(2).includes('--dry-run')

const { accountPurgeEnabled } = await import('../src/config.js')
if (!dryRun && !accountPurgeEnabled()) {
  console.error('account purge is off: set ACCOUNT_PURGE=on to purge, or pass --dry-run')
  process.exit(2)
}

const { runPurge } = await import('../src/accountPurge.js')

const line = (level) => (fields, msg) => console.error(JSON.stringify({ level, msg, ...fields }))
const log = { info: line('info'), warn: line('warn'), error: line('error') }

const result = await runPurge({ dryRun, log })
if (dryRun) {
  for (const { userId, eligible, counts, rows } of result.plans) console.log(JSON.stringify({ userId, eligible, counts, rows }))
} else {
  for (const { userId, counts } of result.purged) console.log(JSON.stringify({ userId, counts }))
}
process.exit(result.failed.length > 0 ? 1 : 0)
