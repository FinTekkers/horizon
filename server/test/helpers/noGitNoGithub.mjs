// HO-893 metric 4: recorders for every child_process entry point and for
// globalThis.fetch, so a test can show the sl Artifact path makes zero `git`
// spawns and zero requests to api.github.com.
//
// Call installRecorders() before the first server module is imported. It
// wraps the CommonJS child_process functions and then calls
// syncBuiltinESMExports(), so the stubs reach the `import { spawn } from
// 'node:child_process'` bindings that server/src uses. A call that is not a
// `git` spawn runs as normal. globalThis.fetch is replaced by a recorder that
// refuses every request, because these tests never need the network.
//
// selfTest() is the positive control. It calls each entry point, through the
// ESM namespace, with `git --version`, and fetches https://api.github.com/x
// once. Each call is recorded and refused (no process starts), and then the
// records are cleared. Without this check a zero count would prove nothing.

import { mock } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import path from 'node:path'

export const ENTRY_POINTS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']
const GITHUB_API_RE = /^https?:\/\/api\.github\.com(?:[/:?]|$)/i

// The program a child_process call would start: the first word of exec's
// command string, otherwise the file argument's base name.
function programOf(name, first) {
  const text = String(first ?? '')
  const word = name === 'exec' || name === 'execSync' ? text.trim().split(/\s+/)[0] : text
  return path.basename(word)
}

export function installRecorders() {
  const spawns = []
  const fetches = []
  let refuseAll = false
  const childProcess = createRequire(import.meta.url)('node:child_process')
  const mocks = []
  for (const name of ENTRY_POINTS) {
    const original = childProcess[name]
    const recorder = mock.method(childProcess, name, function recorded(...args) {
      const program = programOf(name, args[0])
      spawns.push({ name, program })
      if (refuseAll) throw new Error(`${name} is refused in the recorder self-test`)
      return original.apply(this, args)
    })
    mocks.push(recorder)
  }
  syncBuiltinESMExports()
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    fetches.push(String(input?.url ?? input))
    throw new Error('no network in this test')
  }

  const gitSpawns = () => spawns.filter((s) => s.program === 'git')
  const githubRequests = () => fetches.filter((url) => GITHUB_API_RE.test(url))

  return {
    gitSpawns,
    githubRequests,
    // A point to count from: violations(mark) lists only what came after it.
    mark: () => ({ spawns: spawns.length, fetches: fetches.length }),
    violations(since = { spawns: 0, fetches: 0 }) {
      return [
        ...spawns.slice(since.spawns).filter((s) => s.program === 'git').map((s) => `git spawn via ${s.name}`),
        ...fetches.slice(since.fetches).filter((url) => GITHUB_API_RE.test(url)).map((url) => `request to ${url}`),
      ]
    },
    async selfTest() {
      const esm = await import('node:child_process')
      refuseAll = true
      try {
        for (const name of ENTRY_POINTS) {
          const args = name === 'exec' || name === 'execSync' ? ['git --version'] : ['git', ['--version']]
          assert.throws(() => esm[name](...args), /refused in the recorder self-test/, name)
        }
      } finally {
        refuseAll = false
      }
      assert.deepEqual(gitSpawns().map((s) => s.name), ENTRY_POINTS, 'every child_process entry point is recorded')
      await assert.rejects(() => globalThis.fetch('https://api.github.com/x'), /no network/)
      assert.deepEqual(githubRequests(), ['https://api.github.com/x'], 'the fetch recorder sees a GitHub request')
      spawns.length = 0
      fetches.length = 0
    },
    restore() {
      globalThis.fetch = realFetch
      for (const recorder of mocks) recorder.mock.restore()
      syncBuiltinESMExports()
    },
  }
}
