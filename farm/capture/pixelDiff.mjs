// HO-892: the one per-pair screenshot diff, moved unchanged out of diff.mjs
// (HZ-508) so two callers share it:
//   - farm/capture/diff.mjs, for a GitHub item's publish on the farm;
//   - server/src/backends/slArtifacts.js, for an sl item's bundle, diffed
//     against the sl baseline that only the server holds.
// It imports nothing. Each caller hands in its own `pixelmatch` and pngjs
// `PNG`, because the farm resolves them from farm/capture/node_modules and the
// server from server/node_modules (the server host never installs
// farm/capture). Both pin the same versions.
//
// diffPngs(current, baseline, { threshold, ratioTolerance }, { pixelmatch, PNG })
//   → { status: 'same' | 'changed', diffRatio, png: Buffer | null }
// pixelmatch with `threshold` absorbs antialiasing per pixel, and
// `ratioTolerance` absorbs the stray pixels left over. A ratio above the
// tolerance is `changed` with the diff PNG; at or below it is `same` with no
// PNG. Two sizes are always `changed` with diffRatio 1; both are padded to the
// larger canvas so the diff PNG still shows where. Throws on a PNG it cannot
// decode; the caller records that pair's error.

function padded(PNG, png, width, height) {
  if (png.width === width && png.height === height) return png.data
  const out = new PNG({ width, height })
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0)
  return out.data
}

export function diffPngs(current, baseline, { threshold, ratioTolerance }, { pixelmatch, PNG }) {
  const a = PNG.sync.read(current)
  const b = PNG.sync.read(baseline)
  const width = Math.max(a.width, b.width)
  const height = Math.max(a.height, b.height)
  const diff = new PNG({ width, height })
  const diffPixels = pixelmatch(padded(PNG, a, width, height), padded(PNG, b, width, height), diff.data, width, height, {
    threshold,
  })
  const sameSize = a.width === b.width && a.height === b.height
  const diffRatio = sameSize ? diffPixels / (width * height) : 1
  if (diffRatio <= ratioTolerance) return { status: 'same', diffRatio, png: null }
  return { status: 'changed', diffRatio, png: PNG.sync.write(diff) }
}
