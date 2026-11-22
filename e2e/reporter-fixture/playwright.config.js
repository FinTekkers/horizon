// HZ-949: a browser-free Playwright project for jsonl-reporter.test.mjs.
// Outside ./tests, so the real suite never runs it. Same reporter list as the
// real config; FIXTURE_NO_JSONL=1 leaves out the JSON lines (the baseline).
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { e2eReporters } from '../reporters.js'

export default {
  testDir: '.',
  workers: 1,
  retries: 0,
  outputDir: process.env.FIXTURE_OUTPUT_DIR || join(tmpdir(), 'horizon-reporter-fixture-results'),
  reporter: e2eReporters(process.env.HORIZON_TEST_REPORT_DIR, { jsonl: !process.env.FIXTURE_NO_JSONL }),
}
