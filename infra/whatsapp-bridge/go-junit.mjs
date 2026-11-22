// HZ-953: `go test -json` on stdin -> a JUnit report, one case per Go test
// (subtests too), for HORIZON_TEST_REPORT_DIR. run-checks.sh pipes a second,
// report-only `go test -json` run into it; the plain `go test` run before it
// is what prints and sets the exit status.
//
//   go test -json ./... | node go-junit.mjs [--out <file.xml>]
//
// --out defaults to $HORIZON_TEST_REPORT_DIR/whatsapp-bridge-go.xml. Prints
// nothing and always exits 0: a report only ever adds detail. Node, not Go,
// so the converter is tested on hosts with no Go toolchain.
//
// Each case's suite is the package import path and its file the package dir,
// repo-relative (infra/whatsapp-bridge/hzpoll). A package that fails with no
// failing test (a build error, a panic outside a test) is one failing case
// named by its import path, so it still shows by name.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeJunitCases } from '../../server/scripts/junit-cases.mjs'

const HERE = import.meta.dirname
const REPO_DIR = 'infra/whatsapp-bridge'

function modulePath() {
  try {
    return /^module\s+(\S+)/m.exec(readFileSync(path.join(HERE, 'go.mod'), 'utf8'))?.[1] ?? null
  } catch {
    return null
  }
}

function packageFile(pkg, module) {
  if (module && (pkg === module || pkg.startsWith(`${module}/`))) return `${REPO_DIR}${pkg.slice(module.length)}`
  return REPO_DIR
}

// The first line a failing test printed that is not the runner's own.
function firstMessage(lines) {
  for (const line of lines) {
    const text = line.trim()
    if (text && !/^(=== (RUN|PAUSE|CONT|NAME)|--- (FAIL|PASS|SKIP):)/.test(text)) return text
  }
  return undefined
}

// lines: the `go test -json` output, one event per line. Lines that are not
// JSON events are ignored.
export function convert(lines, { module = modulePath() } = {}) {
  const tests = new Map()
  const packages = new Map()
  const testOf = (pkg, name) => {
    const key = `${pkg}\u0000${name}`
    if (!tests.has(key)) tests.set(key, { pkg, name, status: null, seconds: 0, output: [] })
    return tests.get(key)
  }
  for (const line of lines) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!event || typeof event !== 'object' || typeof event.Package !== 'string') continue
    const { Action: action, Package: pkg, Test: name, Elapsed: elapsed, Output: output } = event
    if (typeof name !== 'string' || !name) {
      if (!packages.has(pkg)) packages.set(pkg, { status: null, seconds: 0, output: [] })
      const p = packages.get(pkg)
      if (action === 'output' && typeof output === 'string') p.output.push(output)
      if (action === 'pass' || action === 'fail' || action === 'skip') {
        p.status = action
        p.seconds = Number(elapsed) || 0
      }
      continue
    }
    const t = testOf(pkg, name)
    if (action === 'output' && typeof output === 'string') t.output.push(output)
    if (action === 'pass' || action === 'fail' || action === 'skip') {
      t.status = action
      t.seconds = Number(elapsed) || 0
    }
  }

  const cases = []
  const failedPackages = new Set()
  for (const t of tests.values()) {
    // A test with no end event was cut off by its package failing.
    const status = t.status ?? (packages.get(t.pkg)?.status === 'fail' ? 'fail' : null)
    if (status === null) continue
    if (status === 'fail') failedPackages.add(t.pkg)
    cases.push({
      suite: t.pkg,
      file: packageFile(t.pkg, module),
      name: t.name,
      status,
      seconds: t.seconds,
      message: status === 'fail' ? firstMessage(t.output) : undefined,
    })
  }
  for (const [pkg, p] of packages) {
    if (p.status !== 'fail' || failedPackages.has(pkg)) continue
    cases.push({
      suite: pkg,
      file: packageFile(pkg, module),
      name: pkg,
      status: 'fail',
      seconds: p.seconds,
      message: firstMessage(p.output),
    })
  }
  return cases
}

function main(argv) {
  const at = argv.indexOf('--out')
  const dir = process.env.HORIZON_TEST_REPORT_DIR
  const out = at !== -1 ? argv[at + 1] : dir ? path.join(dir, 'whatsapp-bridge-go.xml') : null
  let input = ''
  try {
    input = readFileSync(0, 'utf8')
  } catch {
    return
  }
  if (!out) return
  writeJunitCases(out, convert(input.split('\n')))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2))
  } catch {
    // A broken report loses the per-test detail, never the check.
  }
  process.exitCode = 0
}
