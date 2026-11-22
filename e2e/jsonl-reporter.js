// HZ-949: one JSON line per test attempt, at start and at finish, appended to
// `outputFile` as it happens — so a run killed at its time limit keeps every
// finished test, and the last `started` line with no `finished` names the
// test it cut off. farm/checks.py's parse_jsonl() (HZ-955, HZ-948) reads it:
//
//   {"event":"started","file":"05-board.spec.js","name":"board › shows lanes","testId":"…","retry":0}
//   {"event":"finished", …same keys…, "status":"pass","outcome":"expected","duration_ms":812}
//
// `file` and `name` are exactly junit's testsuite and testcase names, so the
// farm stores a test once when e2e.xml has it too. A retry writes its own
// pair with the next `retry`; the last `finished` line per test is final.
//
// appendFileSync puts each line in the kernel before the next event, so even
// a SIGKILL loses no written line. A reporter error never fails or aborts the
// run: it warns once on stderr and the reporter goes quiet.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// Playwright's statuses → the farm's.
const STATUS = { passed: 'pass', skipped: 'skip' }
const FAILURE_MAX_CHARS = 4000
const ANSI = /\u001b\[[0-9;]*m/g

export default class JsonlReporter {
  constructor({ outputFile } = {}) {
    this.outputFile = outputFile || null
    this.broken = false
  }

  printsToStdio() {
    return false
  }

  onBegin() {
    this.guard(() => mkdirSync(dirname(this.outputFile), { recursive: true }))
  }

  onTestBegin(test, result) {
    this.guard(() => this.write({ event: 'started', ...this.identity(test, result) }))
  }

  onTestEnd(test, result) {
    this.guard(() => {
      const failure = result.error?.message
      this.write({
        event: 'finished',
        ...this.identity(test, result),
        status: STATUS[result.status] || 'fail',
        outcome: test.outcome(),
        duration_ms: Math.max(0, Math.round(result.duration)),
        ...(failure ? { failure: failure.replace(ANSI, '').slice(0, FAILURE_MAX_CHARS) } : {}),
      })
    })
  }

  identity(test, result) {
    const titles = []
    let suite = test.parent
    while (suite && suite.type !== 'file') {
      titles.unshift(suite.title)
      suite = suite.parent
    }
    return {
      file: suite ? suite.title : test.location.file,
      name: [...titles, test.title].join(' › '),
      testId: test.id,
      retry: result.retry,
    }
  }

  write(line) {
    appendFileSync(this.outputFile, JSON.stringify(line) + '\n')
  }

  guard(fn) {
    if (!this.outputFile || this.broken) return
    try {
      fn()
    } catch (err) {
      this.broken = true
      process.stderr.write(`jsonl-reporter: stopped writing ${this.outputFile} (${err.message}); the run is unaffected\n`)
    }
  }
}
