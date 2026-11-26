// HZ-972: where the farm's files live, and the one project-name slug rule —
// pure, with no imports of our own, so a module on a guarded import path
// (quantResources.js, reached from the WhatsApp vote path through
// goldenCases.js) can find farm/projects/<slug>/ without definitions.js.
// definitions.js re-exports all three.

import path from 'node:path'

// Server and farm live in one repo/checkout, so a UI edit is immediately what
// farmd stamps into the next task. Overridable for tests only.
export const FARM_DIR = process.env.HORIZON_FARM_DIR || path.resolve(import.meta.dirname, '../../farm')

// Mirror of farm/config.py slugify (ASCII names — parity holds for those).
// HZ-538: substeps.js reads farm/projects/<slug>/ through it too.
export function slugify(name) {
  return [...name.toLowerCase()].map((c) => (/[a-z0-9]/.test(c) ? c : '-')).join('').replace(/^-+|-+$/g, '')
}

// ---- HZ-535: project personas (farm/projects/<slug>/personas.json) ----
// Mirror of farm/personas.py load_project_personas. Server and farm read the
// same directory (one checkout); the parity test asserts it.
export const PROJECTS_DIR = path.join(FARM_DIR, 'projects')
