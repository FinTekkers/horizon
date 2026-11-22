// HZ-953: JUnit XML for the suites that are not `node --test` runs, for
// HORIZON_TEST_REPORT_DIR. farm/checks.py's parse_junit reads it, as it reads
// junit-reporter.mjs's server.xml. Not server-only — its callers are:
//
//   server/scripts/junit-reporter.mjs    escapeXml
//   infra/host/test/run-all.sh           the CLI below, one case per script
//   infra/whatsapp-bridge/go-junit.mjs   one case per Go test
//   ui/scripts/verify-base-build.mjs     one case per assertion (orderedCases)
//
// (scripts/tenant-sites/parvati-site/check-links.mjs has its own copy: that
// folder is pushed as a standalone repo.)
//
//   node junit-cases.mjs --suite <name> --tsv <cases.tsv> --out <file.xml>
//
// Each TSV line is `status<TAB>seconds<TAB>name<TAB>file[<TAB>message]`,
// status one of pass, fail, skip. The CLI prints nothing and always exits 0:
// a report only ever adds detail, it never decides a check.

import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const escapeXml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // XML 1.0 has no escape for most control characters.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

// cases: [{ name, file, status: 'pass'|'fail'|'skip', seconds, message?, suite? }].
// One <testsuite> per (suite, file), as junit-reporter.mjs writes; a case's
// own suite wins over opts.suite.
export function toJunitXml(cases, { suite = '' } = {}) {
  const suites = new Map()
  for (const c of cases) {
    const caseSuite = c.suite ?? suite
    const file = c.file ?? ''
    const key = `${caseSuite}\u0000${file}`
    if (!suites.has(key)) suites.set(key, { suite: caseSuite, file, cases: [] })
    suites.get(key).cases.push(c)
  }
  let xml = '<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n'
  for (const { suite: name, file, cases: list } of suites.values()) {
    xml += `  <testsuite name="${escapeXml(name)}" file="${escapeXml(file)}" tests="${list.length}">\n`
    for (const { name: test, status, seconds, message } of list) {
      const failure = message ? `<failure message="${escapeXml(message)}"/>` : '<failure/>'
      const body = status === 'fail' ? failure : status === 'skip' ? '<skipped/>' : ''
      const time = Number.isFinite(Number(seconds)) ? Number(seconds) : 0
      xml += `    <testcase name="${escapeXml(test)}" file="${escapeXml(file)}" time="${time.toFixed(6)}">${body}</testcase>\n`
    }
    xml += '  </testsuite>\n'
  }
  return `${xml}</testsuites>\n`
}

// A script's assertions, run in order until the first failure: the ones
// before failedAt pass, failedAt fails with message, the rest never ran and
// are skipped. failedAt -1 (or past the end): every one passed.
export function orderedCases(names, failedAt, { file = '', message, seconds = [] } = {}) {
  return names.map((name, i) => ({
    name,
    file,
    status: failedAt === -1 || i < failedAt ? 'pass' : i === failedAt ? 'fail' : 'skip',
    seconds: seconds[i] ?? 0,
    message: i === failedAt ? message : undefined,
  }))
}

// Never throws: false when the report could not be written.
export function writeJunitCases(outPath, cases, opts) {
  try {
    writeFileSync(outPath, toJunitXml(cases, opts))
    return true
  } catch {
    return false
  }
}

export function parseTsv(text) {
  const cases = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const [status, seconds, name, file, message] = line.split('\t')
    if (!name) continue
    cases.push({ status, seconds: Number(seconds), name, file, message })
  }
  return cases
}

function main(argv) {
  const opts = Object.create(null)
  for (let i = 0; i < argv.length; i += 2) opts[argv[i]] = argv[i + 1]
  if (!opts['--tsv'] || !opts['--out']) return
  writeJunitCases(opts['--out'], parseTsv(readFileSync(opts['--tsv'], 'utf8')), { suite: opts['--suite'] ?? '' })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2))
  } catch {
    // A missing TSV loses the report, never the check.
  }
  process.exitCode = 0
}
