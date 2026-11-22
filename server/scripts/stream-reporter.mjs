// HZ-951: streams one JSON line per test start and finish to
// $HORIZON_TEST_REPORT_DIR/server.jsonl (see package.json's test script), so a
// run killed at its time limit still leaves every finished test on disk and
// names the one it was running. junit-reporter.mjs still writes server.xml;
// farm/checks.py's parse_jsonl() reads this file next to it (HZ-955/948), and
// an XML row for the same test wins.
//
// Line shape — the one parse_jsonl() reads:
//   {"event":"started","name":<test>,"file":<path>,"suite":<describe path>}
//   {"event":"finished", …the same…, "status":"pass"|"fail"|"skip","duration_ms":<int>,"failure":<on fail>}
// `name` and `file` are server.xml's <testcase> name and file, so the farm
// stores a test once; `suite` is its describe path joined with ' > ', as
// server.xml's <testsuite> name.
//
// Each line is one synchronous append, written here rather than through the
// reporter's destination stream (asynchronous): a SIGKILL loses at most the
// line being written. Any error turns the stream off for the rest of the run
// and is never thrown, so the report only ever loses detail.

import { appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// The farm reads at most this much of a failure (FAILURE_TEXT_MAX_CHARS).
const FAILURE_MAX = 4000

function failureText(error) {
  try {
    const cause = error?.cause ?? error
    return String(cause?.message || error?.message || cause || '').slice(0, FAILURE_MAX)
  } catch {
    return ''
  }
}

export default async function* streamReporter(source) {
  const dir = process.env.HORIZON_TEST_REPORT_DIR
  let path = dir ? join(dir, 'server.jsonl') : null
  const write = (entry) => {
    if (!path) return
    try {
      appendFileSync(path, `${JSON.stringify(entry)}\n`)
    } catch {
      path = null
    }
  }
  // file:line:column:name -> 'suite' | 'test' from test:enqueue. A top-level
  // describe's test:dequeue says 'test'; its enqueue says 'suite'.
  const kinds = new Map()
  // file -> names dequeued at each nesting level, for the describe path.
  const open = new Map()
  // file:line:column:name -> the started line's fields, reused when it finishes.
  const started = new Map()
  for await (const event of source) {
    if (!path) continue
    try {
      const { name, file = '', nesting = 0, line, column, type, details, skip, todo } = event.data ?? {}
      const key = `${file}:${line}:${column}:${name}`
      if (event.type === 'test:enqueue') {
        kinds.set(key, type)
        continue
      }
      if (event.type === 'test:dequeue') {
        const stack = open.get(file) ?? []
        stack.length = nesting
        stack[nesting] = name
        open.set(file, stack)
        // The runner's own per-file test is named by the file's path.
        const wholeFile = nesting === 0 && resolve(String(name)) === file
        if ((kinds.get(key) ?? type) === 'suite' || wholeFile) continue
        const fields = { name, file, suite: stack.slice(0, nesting).join(' > ') }
        started.set(key, fields)
        write({ event: 'started', ...fields })
        continue
      }
      if ((event.type !== 'test:pass' && event.type !== 'test:fail') || details?.type === 'suite') continue
      const fields = started.get(key) ?? { name, file, suite: (open.get(file) ?? []).slice(0, nesting).join(' > ') }
      started.delete(key)
      const status = event.type === 'test:fail' ? 'fail' : skip || todo ? 'skip' : 'pass'
      const entry = { event: 'finished', ...fields, status, duration_ms: Math.round(details?.duration_ms ?? 0) }
      if (status === 'fail') entry.failure = failureText(details?.error)
      write(entry)
    } catch {
      path = null
    }
  }
}
