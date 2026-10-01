// HZ-183: Accept the code runs the pre-merge check before the merge call, so a
// test about what happens AT the merge has to get past a green check first.
// Stubs premerge.runner green and answers the two GitHub reads the gate makes
// (the PR head, the base tip); every other GitHub call goes to `rest`.
// The gate itself is covered in premerge-gate.test.mjs.
export async function withGreenPremerge(premerge, rest, fn) {
  const head = 'a'.repeat(40)
  const base = 'b'.repeat(40)
  const realFetch = globalThis.fetch
  const realSpawn = premerge.runner.spawn
  premerge.runner.spawn = async () => ({
    code: 0,
    stdout: JSON.stringify({ ok: true, head_sha: head, base_sha: base }),
    stderr: '',
    timedOut: false,
  })
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname
    if (/\/pulls\/\d+$/.test(path)) {
      return { ok: true, status: 200, json: async () => ({ head: { sha: head, ref: 'horizon/x' }, base: { ref: 'main' } }) }
    }
    if (path.endsWith('/git/ref/heads%2Fmain')) return { ok: true, status: 200, json: async () => ({ object: { sha: base } }) }
    return rest(url, options)
  }
  try {
    return await fn()
  } finally {
    globalThis.fetch = realFetch
    premerge.runner.spawn = realSpawn
  }
}
