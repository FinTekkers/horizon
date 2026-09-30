import { test, expect, captureScreenshot } from '../fixtures/test-base.js'

// HZ-114: resolveRules/renderRulesSection changed from a pre-joined string
// to a list of parts (so an oversized part can be dropped whole instead of
// sliced mid-part). The only prior coverage was unit-level, calling
// renderRulesSection directly with hand-built arrays — nothing proved the
// refactor still composes correctly through the real, live
// "Preview effective prompt" surface a human actually uses
// (AgentDefinitionsPage → GET /api/definitions/effective).
//
// This deliberately only reads existing definitions (farm/rules/projects/
// fintekkers.md, a real file in this repo) — never Save, which commits to
// git and pushes to origin (writeDefinition in definitions.js). Exercising
// that here would create real commits against this checkout from a test
// run, which is exactly the kind of side effect this suite must not have.
test('the effective-prompt preview renders real project rules through the live UI', async ({ page }) => {
  await page.goto('/definitions')

  const projectsGroup = page.locator('.defs__group').filter({ has: page.locator('.defs__group-title', { hasText: 'Projects' }) })
  const fintekkersItem = projectsGroup.locator('.defs__item', { hasText: 'fintekkers' })
  await expect(fintekkersItem).toBeVisible({ timeout: 10_000 })
  await fintekkersItem.click()

  // Selecting loads the raw file via GET /api/definitions/project/fintekkers.
  await expect(page.locator('.defs__textarea')).toContainText('FinTekkers — project rules', { timeout: 10_000 })

  await page.locator('button', { hasText: 'Preview effective prompt' }).click()

  // The merged prompt (role -> persona -> project rules) comes back from the
  // real GET /api/definitions/effective, reading the real file through the
  // post-refactor resolveRules()/renderRulesSection() composition — not a
  // hand-built array like the unit tests use.
  const preview = page.locator('.defs__preview-body')
  await expect(preview).toBeVisible({ timeout: 10_000 })
  await expect(preview).toContainText('## Project rules')
  await expect(preview).toContainText('Cross-repo facts every agent on this project needs')

  await captureScreenshot(page, 'definitions-preview')
})
