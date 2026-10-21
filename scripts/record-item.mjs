#!/usr/bin/env node
// HZ-518: the time-lapse recorder. The code lives in scripts/recorder/, its
// own package, so playwright resolves from scripts/recorder/node_modules and
// never becomes a root dependency. Run `npm --prefix scripts/recorder install`
// once first. `--help` prints the usage and the exit-code table.

let run
let RecorderError
try {
  ;({ run } = await import('./recorder/main.mjs'))
  ;({ RecorderError } = await import('./recorder/errors.mjs'))
} catch (err) {
  process.stderr.write(`record-item: could not load the recorder (${err.code || err.message}). Run: npm --prefix scripts/recorder install\n`)
  process.exit(1)
}

try {
  await run(process.argv.slice(2))
} catch (err) {
  process.stderr.write(`record-item: ${err instanceof RecorderError ? err.message : err.stack || err}\n`)
  process.exit(err instanceof RecorderError ? err.exitCode : 1)
}
