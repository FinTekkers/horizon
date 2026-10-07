// HZ-327: the server suite's JUnit XML for HORIZON_TEST_REPORT_DIR (see
// package.json's test script). Node's built-in junit reporter leaves out the
// test file, and a test's history is per file: two files may hold a test of
// the same name. One <testsuite> per (file, describe path); a top-level test's
// suite name is empty. farm/checks.py's parse_junit reads it.

const escapeXml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // XML 1.0 has no escape for most control characters.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

export default async function* junitReporter(source) {
  // file -> names of the tests started at each nesting level, so a case can be
  // named by its describe path. test:start comes in definition order per file.
  const open = new Map()
  const suites = new Map()
  for await (const event of source) {
    const { name, file = '', nesting = 0, details, skip, todo } = event.data ?? {}
    if (event.type === 'test:start') {
      const path = open.get(file) ?? []
      path.length = nesting
      path[nesting] = name
      open.set(file, path)
      continue
    }
    if ((event.type !== 'test:pass' && event.type !== 'test:fail') || details?.type === 'suite') continue
    const suite = (open.get(file) ?? []).slice(0, nesting).join(' > ')
    const key = `${file}\u0000${suite}`
    if (!suites.has(key)) suites.set(key, { file, suite, cases: [] })
    const status = event.type === 'test:fail' ? 'fail' : skip || todo ? 'skip' : 'pass'
    suites.get(key).cases.push({ name, status, seconds: (details?.duration_ms ?? 0) / 1000 })
  }
  let xml = '<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n'
  for (const { file, suite, cases } of suites.values()) {
    xml += `  <testsuite name="${escapeXml(suite)}" file="${escapeXml(file)}" tests="${cases.length}">\n`
    for (const { name, status, seconds } of cases) {
      const body = status === 'fail' ? '<failure/>' : status === 'skip' ? '<skipped/>' : ''
      xml += `    <testcase name="${escapeXml(name)}" file="${escapeXml(file)}" time="${seconds.toFixed(6)}">${body}</testcase>\n`
    }
    xml += '  </testsuite>\n'
  }
  yield `${xml}</testsuites>\n`
}
