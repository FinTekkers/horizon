// Real work-item events are persisted server-side with a literal hex
// `color` (server/src/lifecycle.js's AGENTS map, server/src/store.js's
// addEvent calls) — that hex predates theming (HZ-25) and would stay
// light-colored under a dark background if rendered directly. It's drawn
// from a small closed set that lines up with this file's own domain
// palette, so each value resolves to the matching themed CSS token instead.
// Plain .js (not .jsx) so server/test/personas.test.mjs can import it
// directly, without a JSX loader, to assert every server AGENTS color has a
// resolution entry here — see that test for the parity check this replaced.
export const SERVER_EVENT_COLOR_TOKENS = {
  '#2E6CB2': 'var(--primary)',
  '#38294F': 'var(--brand-deep)',
  '#0E6E74': 'var(--success)',
  '#9C333E': 'var(--danger)',
  '#DFA200': 'var(--warning)',
  '#5E4380': 'var(--agent-human)',
  '#2A2A2E': '#2A2A2E', // GitHub/system actor — already dark enough for white text in both themes
  '#8C8C8E': 'var(--muted-solid)',
}

export function resolveEventColor(hex) {
  return SERVER_EVENT_COLOR_TOKENS[(hex || '').toUpperCase()] || hex
}
