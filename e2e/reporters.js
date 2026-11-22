// HZ-949: the reporter list for playwright.config.js and the reporter
// fixture, so both run the same reporters. With no report dir, `list` only.
// With one, `list` and `junit` (HZ-327) exactly as before, plus the streamed
// JSON lines (jsonl-reporter.js) next to them, never in their place.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const JSONL_NAME = 'e2e.jsonl'
const JSONL_REPORTER = fileURLToPath(new URL('./jsonl-reporter.js', import.meta.url))

export function e2eReporters(reportDir, { jsonl = true } = {}) {
  if (!reportDir) return [['list']]
  return [
    ['list'],
    ['junit', { outputFile: join(reportDir, 'e2e.xml') }],
    ...(jsonl ? [[JSONL_REPORTER, { outputFile: join(reportDir, JSONL_NAME) }]] : []),
  ]
}
