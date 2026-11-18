// HZ-508: the per-screen diff behind every screenshot publish.
// farm/step_agent.py's publish_screenshots() runs it once per publish, owns
// its timeout, and checks every result before anything reaches the ref.
//
// Protocol, one JSON object each way:
//   stdin:  {"pairs": [{"name", "current", "baseline"}], "outDir", "resultFile", "threshold", "ratioTolerance"}
//           (current/baseline are PNG paths on disk)
//   resultFile, written once at the end: {"shots": [{"name", "status", "diffRatio", "error"}]}
//
// Per pair: pixelmatch with `threshold` absorbs antialiasing per pixel, and
// `ratioTolerance` absorbs the stray pixels left over. A ratio above the
// tolerance is `changed` and writes <outDir>/<name>.png; at or below it is
// `same` and writes nothing. Two sizes are always `changed` with diffRatio 1;
// both are padded to the larger canvas so the diff PNG still shows where.
// A pair that fails (e.g. a corrupt PNG) is `changed` with `error` set and no
// PNG; the other pairs still run. Exits non-zero only when the run as a whole
// fails, e.g. bad input.
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import { diffPngs } from './pixelDiff.mjs'

// HO-892: the pixel work is pixelDiff.mjs's, shared with the sl store.
function diffPair(pair, { outDir, threshold, ratioTolerance }) {
  const result = diffPngs(readFileSync(pair.current), readFileSync(pair.baseline), { threshold, ratioTolerance }, { pixelmatch, PNG })
  if (result.png) writeFileSync(join(outDir, `${basename(pair.name)}.png`), result.png)
  return { name: pair.name, status: result.status, diffRatio: result.diffRatio, error: null }
}

const input = JSON.parse(readFileSync(0, 'utf8'))
if (!Array.isArray(input?.pairs) || typeof input.outDir !== 'string' || typeof input.resultFile !== 'string') {
  throw new Error('expected {pairs, outDir, resultFile}')
}
if (typeof input.threshold !== 'number' || typeof input.ratioTolerance !== 'number') {
  throw new Error('expected numeric threshold and ratioTolerance')
}
const shots = input.pairs.map((pair) => {
  try {
    return diffPair(pair, input)
  } catch (err) {
    return { name: pair.name, status: 'changed', diffRatio: null, error: String(err?.message || err).slice(0, 300) }
  }
})
writeFileSync(input.resultFile, `${JSON.stringify({ shots })}\n`)
