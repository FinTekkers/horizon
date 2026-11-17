// HO-850: the canvas line of a `design` sub-step's artifact — the one contract
// between the farm, which writes it (farm/design_canvas.py), and the server,
// which reads the last round's canvas back from it for the next round.
//
// A design run's artifact opens with exactly this line:
//
//   **Canvas:** [Open the design canvas](https://blueprint-studio.internalmeta.com/canvas/<slug>) · slug `<slug>` · version <n>
//
// The link, the Studio slug and the version `meta studio.canvas apply`
// answered, stored together. Only the artifact's FIRST line is read, so a
// canvas line inside the agent's own text below it is never taken for the
// farm's. The link is https on the Studio host with no query or fragment, so
// it cannot carry a token. farm/tests/test_design_substep.py pins the Python
// side to these constants.
//
// Pure: no I/O.

export const CANVAS_MARKER = '**Canvas:**'
export const CANVAS_LINK_TEXT = 'Open the design canvas'
export const CANVAS_HOST = 'blueprint-studio.internalmeta.com'
export const CANVAS_SLUG_PATTERN = '[a-z0-9][a-z0-9-]{0,99}'

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const LINE_RE = new RegExp(
  `^${escape(CANVAS_MARKER)} \\[${escape(CANVAS_LINK_TEXT)}\\]\\((https://${escape(CANVAS_HOST)}/canvas/(${CANVAS_SLUG_PATTERN}))\\) · slug \`\\2\` · version ([1-9][0-9]{0,8})$`,
)

export function canvasUrlFor(slug) {
  return `https://${CANVAS_HOST}/canvas/${slug}`
}

// { url, slug, version } from the artifact's first line, or null.
export function parseCanvasLine(artifact) {
  if (typeof artifact !== 'string') return null
  const match = LINE_RE.exec(artifact.split('\n', 1)[0].replace(/\r$/, ''))
  return match ? { url: match[1], slug: match[2], version: Number(match[3]) } : null
}

// The newest canvas among a sub-step's done runs (oldest first, as
// store.substepDoneRuns lists them), or null when no round made one.
export function latestCanvas(runs) {
  for (const run of [...(runs ?? [])].reverse()) {
    const canvas = parseCanvasLine(run?.artifact)
    if (canvas) return canvas
  }
  return null
}
