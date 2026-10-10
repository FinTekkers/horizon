import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

// HZ-400: regenerates the committed screenshots in docs/images/onboarding/
// for docs/project-onboarding.md. Run on purpose only, with
// `npm --prefix e2e run screenshots:onboarding`; the default `test` script
// and playwright.config.js's testDir ('./tests') never load ./onboarding, so
// a normal e2e run never rewrites a tracked PNG.
//
// Everything else comes from the base config, imported for its side effects
// too: the temp DB, the RUN_KEY ports, the demo-mode webServer (no GitHub
// token, no HORIZON_REPO, no farm, no WhatsApp) and global setup's login. It
// shares those ports and the storage-state file with `npm --prefix e2e test`
// in the same worktree, so run it alone.
export default defineConfig({
  ...base,
  testDir: './onboarding',
  // The steps share one seeded project and run in the doc's order.
  fullyParallel: false,
  workers: 1,
  // Never a farm JUnit row: these are docs assets, not a check.
  reporter: [['list']],
})
