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

// A box with no design tool (no `meta` on this host) answers this line in
// place of a canvas line, and the server records the round as a skip, so the
// item moves on to its gate instead of pausing. Same first-line rule.
export const NO_TOOL_MARKER = '**No design tool:**'

export function formatNoToolLine(reason) {
  return `${NO_TOOL_MARKER} ${String(reason).replace(/\s+/g, ' ').trim()}`
}

// The reason on the artifact's first line when it is a no-tool line, else null.
export function parseNoToolLine(artifact) {
  if (typeof artifact !== 'string') return null
  const first = artifact.split('\n', 1)[0].replace(/\r$/, '')
  if (!first.startsWith(`${NO_TOOL_MARKER} `)) return null
  const reason = first.slice(NO_TOOL_MARKER.length + 1).trim()
  return reason || null
}

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

// ---- HZ-938: the tool that drew a round ----
//
// A box draws its design rounds with the tool FARM_DESIGN_BACKEND names
// (farm/design_backend.py): Meta Studio (the canvas line above), Claude Design
// or a Horizon page. Each writes its own first line, by the same first-line
// rule; farm/tests/test_design_backend.py pins the Python side to these
// constants.
//
//   **Design page:** [Open the design page](/api/items/<id>/design-page) · round <n>
//   **Claude Design:** [Open the Claude Design project](https://claude.ai/design/p/<uuid>) · project `<uuid>` · round <n>
//
// The design page link is the server's own sandboxed route, never anything
// else; the Claude link is https on claude.ai only, with no query or fragment.

export const DESIGN_TOOLS = Object.freeze(['studio', 'claude', 'html'])
export const PAGE_MARKER = '**Design page:**'
export const PAGE_LINK_TEXT = 'Open the design page'
export const PAGE_ITEM_ID_PATTERN = '[A-Za-z0-9][A-Za-z0-9_-]{0,63}'
export const CLAUDE_MARKER = '**Claude Design:**'
export const CLAUDE_LINK_TEXT = 'Open the Claude Design project'
export const CLAUDE_HOST = 'claude.ai'
export const CLAUDE_PROJECT_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

// What the card says, by tool. The server and the UI read these; the farm
// never writes card text.
export const TOOL_LABEL = Object.freeze({ studio: 'Meta Studio', claude: 'Claude Design', html: 'Horizon page' })
export const FALLBACK_TEXT = Object.freeze({
  studio: "Studio isn't available on this box; drawn as a Horizon page",
  claude: "Claude Design isn't available on this box; drawn as a Horizon page",
})

const PAGE_LINE_RE = new RegExp(
  `^${escape(PAGE_MARKER)} \\[${escape(PAGE_LINK_TEXT)}\\]\\((/api/items/(${PAGE_ITEM_ID_PATTERN})/design-page)\\) · round ([1-9][0-9]{0,8})$`,
)
const CLAUDE_LINE_RE = new RegExp(
  `^${escape(CLAUDE_MARKER)} \\[${escape(CLAUDE_LINK_TEXT)}\\]\\((https://${escape(CLAUDE_HOST)}/design/p/(${CLAUDE_PROJECT_PATTERN}))\\) · project \`\\2\` · round ([1-9][0-9]{0,8})$`,
)

export function claudeProjectUrlFor(projectId) {
  return `https://${CLAUDE_HOST}/design/p/${projectId}`
}

// { tool, url, id, round } from the artifact's first line — a Studio canvas
// (id is the slug, round its version), a design page (id is the item) or a
// Claude Design project — or null.
export function parseDesignLine(artifact) {
  if (typeof artifact !== 'string') return null
  const first = artifact.split('\n', 1)[0].replace(/\r$/, '')
  const studio = parseCanvasLine(first)
  if (studio) return { tool: 'studio', url: studio.url, id: studio.slug, round: studio.version }
  const page = PAGE_LINE_RE.exec(first)
  if (page) return { tool: 'html', url: page[1], id: page[2], round: Number(page[3]) }
  const claude = CLAUDE_LINE_RE.exec(first)
  if (claude) return { tool: 'claude', url: claude[1], id: claude[2], round: Number(claude[3]) }
  return null
}

// The newest design among a sub-step's done runs (oldest first) whose tool is
// one of `tools`, or null.
export function latestDesign(runs, tools = DESIGN_TOOLS) {
  for (const run of [...(runs ?? [])].reverse()) {
    const design = parseDesignLine(run?.artifact)
    if (design && tools.includes(design.tool)) return design
  }
  return null
}
