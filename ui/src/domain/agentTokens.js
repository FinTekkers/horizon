// Presentation tokens for the lifecycle agent roles, UI side.
//
// HZ-128 moved the step MODEL to domain/ (domain/steps.json -> domain/js/
// lifecycle.js), which carries no colours. This map stays hand-owned here:
// `color` is a theme-aware token — legible as text/dot fill against a neutral
// surface in both themes (see the "-ink" tokens in index.css). `avatarBg` is
// the same hue's solid form, used only for the activity-feed avatar (white
// initials on top) — that pairing's contrast doesn't depend on page theme, so
// it stays close to its light-mode value; only --warning gets darkened for
// dark mode since white-on-#DFA200 needs it either way.
//
// `Human` has no server counterpart: gates are rendered with it, and the farm
// never dispatches a gate. label/initials are duplicated against
// server/src/agentTokens.js — the one documented surviving duplicate (see
// domain/README.md), guarded by server/test/personas.test.mjs.
export const AGENTS = {
  PM: { label: 'PM agent', initials: 'PM', color: 'var(--primary-ink)', avatarBg: 'var(--primary)' },
  QA: { label: 'QA agent', initials: 'QA', color: 'var(--warning-ink)', avatarBg: 'var(--warning)' },
  Architect: { label: 'Architect agent', initials: 'AR', color: 'var(--architect-ink)', avatarBg: 'var(--brand-deep)' },
  Eng: { label: 'Eng agent', initials: 'EN', color: 'var(--success-ink)', avatarBg: 'var(--success)' },
  DevOps: { label: 'DevOps agent', initials: 'DO', color: 'var(--danger-ink)', avatarBg: 'var(--danger)' },
  Ensemble: { label: 'PM · QA · Architect', initials: 'EN', color: 'var(--primary-ink)', avatarBg: 'var(--primary)' },
  Review: { label: 'Code · QA review (automated)', initials: 'RV', color: 'var(--agent-human-ink)', avatarBg: 'var(--agent-human)' },
  Human: { label: 'Human gate', initials: 'YOU', color: 'var(--agent-human-ink)', avatarBg: 'var(--agent-human)' },
}
