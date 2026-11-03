// Shared by the HZ-718 publish tests: run main() in-process or the real CLI
// against the stub GitHub, with captured output and no real waits.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { main } from '../publish/publish.mjs'

export const TOKEN = 'parvati-test-sentinel-token-0b9d'
const HERE = import.meta.dirname
const PUBLISH = path.resolve(HERE, '../publish/publish.mjs')

export function tempDir(t, prefix = 'hz718-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// Writes desktop.png and mobile.png like the real captureScreens would.
export async function fakeScreens({ outDir }) {
  mkdirSync(outDir, { recursive: true })
  const shots = { desktop: path.join(outDir, 'desktop.png'), mobile: path.join(outDir, 'mobile.png') }
  for (const file of Object.values(shots)) writeFileSync(file, 'png')
  return shots
}

// Runs main() in-process with captured output and an instant sleep.
export async function run(t, stub, argv = [], opts = {}) {
  const outDir = opts.outDir ?? path.join(tempDir(t), 'out')
  let stdout = ''
  let stderr = ''
  const sleeps = []
  const code = await main(argv, {
    env: { PARVATI_GITHUB_TOKEN: TOKEN },
    fetch: stub.fetch,
    screens: fakeScreens,
    sleep: async (ms) => { sleeps.push(ms) },
    outDir,
    ...opts,
    stdout: { write: (s) => { stdout += s } },
    stderr: { write: (s) => { stderr += s } },
  })
  const reportFile = path.join(outDir, 'publish-report.json')
  const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null
  return { code, stdout, stderr, sleeps, report, outDir }
}

// Runs the real CLI with the stub preloaded; returns its exit, output and the
// fetch / env-read log.
export function runCli(t, argv, { env = {}, scenario = {} } = {}) {
  const log = path.join(tempDir(t), 'calls.jsonl')
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/GITHUB_TOKEN$/.test(k)))
  const r = spawnSync(process.execPath, ['--import', path.join(HERE, 'record-fetch.mjs'), PUBLISH, ...argv], {
    env: { ...base, ...env, STUB_GITHUB_LOG: log, STUB_GITHUB_SCENARIO: JSON.stringify(scenario) },
    encoding: 'utf8',
  })
  const entries = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : null
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, entries }
}
