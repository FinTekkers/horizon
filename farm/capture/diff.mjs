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

function padded(png, width, height) {
  if (png.width === width && png.height === height) return png.data
  const out = new PNG({ width, height })
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0)
  return out.data
}

function diffPair(pair, { outDir, threshold, ratioTolerance }) {
  const a = PNG.sync.read(readFileSync(pair.current))
  const b = PNG.sync.read(readFileSync(pair.baseline))
  const width = Math.max(a.width, b.width)
  const height = Math.max(a.height, b.height)
  const diff = new PNG({ width, height })
  const diffPixels = pixelmatch(padded(a, width, height), padded(b, width, height), diff.data, width, height, {
    threshold,
  })
  const sameSize = a.width === b.width && a.height === b.height
  const diffRatio = sameSize ? diffPixels / (width * height) : 1
  if (diffRatio <= ratioTolerance) return { name: pair.name, status: 'same', diffRatio, error: null }
  writeFileSync(join(outDir, `${basename(pair.name)}.png`), PNG.sync.write(diff))
  return { name: pair.name, status: 'changed', diffRatio, error: null }
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
