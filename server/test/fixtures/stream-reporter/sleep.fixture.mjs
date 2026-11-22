// HZ-951: stream-reporter.test.mjs runs this file and kills the run while
// the second test sleeps. Not a *.test.mjs file, so `npm test` never runs it.
import { test } from 'node:test'

test('first', () => {})

test('sleeps', async () => {
  await new Promise((resolve) => setTimeout(resolve, 60_000))
})
