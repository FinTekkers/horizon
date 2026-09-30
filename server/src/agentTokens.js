// Presentation tokens for the lifecycle agent roles, server side.
//
// HZ-128 moved the step MODEL to domain/ (domain/steps.json -> domain/js/
// lifecycle.js). Presentation deliberately did not go with it: `color` here is
// the literal light-mode hex the server persists into an activity event's
// `color` column, which ui/src/domain/eventColors.js resolves to a theme-aware
// token at render time. domain/ carries no colours at all.
//
// This map's label/initials remain duplicated against ui/src/domain/
// agentTokens.js — the UI needs the same roles with themed colours instead of
// hex. That surviving overlap is the ONE documented duplicate (see
// domain/README.md) and is guarded by server/test/personas.test.mjs and
// server/test/domain-no-duplicate-exports.test.mjs.
export const AGENTS = {
  PM: { label: 'PM agent', initials: 'PM', color: '#2E6CB2' },
  QA: { label: 'QA agent', initials: 'QA', color: '#DFA200' },
  Architect: { label: 'Architect agent', initials: 'AR', color: '#38294F' },
  Eng: { label: 'Eng agent', initials: 'EN', color: '#0E6E74' },
  DevOps: { label: 'DevOps agent', initials: 'DO', color: '#9C333E' },
  Ensemble: { label: 'PM · QA · Architect', initials: 'EN', color: '#2E6CB2' },
  Review: { label: 'Code · QA review (automated)', initials: 'RV', color: '#5E4380' },
}
