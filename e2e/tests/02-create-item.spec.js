import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
// HZ-135: read off the vocabulary rather than typed. Nothing in this file names a
// priority, so it is not a hit for server/test/domain-priority-literals.test.mjs —
// and a value added to domain/priorities.json has to reach the real browser or the
// picker assertion below fails.
import { PRIORITIES, DEFAULT_PRIORITY } from '../../domain/js/priorities.js'

test('creating a work item via the modal adds it to the board', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '+ New work item' }).click()

  const title = `E2E created item ${Date.now()}`
  await page.getByPlaceholder(/One line naming the work/).fill(title)
  await page
    .getByPlaceholder(/Risk managers get a live view/)
    .fill('A clear outcome description for this e2e journey, well over ten characters.')
  await page.getByPlaceholder(/Limit breaches acknowledged/).fill('A measurable success metric for e2e verification.')

  // ---- HZ-135: the priority path, at browser level ----
  //
  // This journey opened the real intake modal and clicked Create without ever
  // touching the priority control, and no other spec in this suite renders it. So
  // a picker that shipped ZERO options — the exact failure a dropped
  // domain/priorities.json produces, since the UI inlines that JSON at build time
  // rather than fetching it — left all of these tests green. The vitest component
  // test (ui/src/components/NewItemModal.test.jsx) renders the same component, but
  // through Vite's dev resolution, not the bundle nginx actually serves.
  //
  // Scoped by the visible field label: the repository control reuses the same
  // `.prio-seg__btn` class, so an unscoped selector would silently start counting
  // repo buttons as priorities for a multi-repo project.
  const priorityField = page.locator('.composer__panel .field').filter({ hasText: 'Priority' })
  // Array form, so this asserts the OPTIONS AND THEIR ORDER, and fails on a count
  // mismatch — an empty picker or a stale hand-typed list beside the import.
  await expect(priorityField.locator('.prio-seg__btn')).toHaveText(PRIORITIES)

  // Deliberately NOT the default: a created item reading back as the default
  // proves nothing, because that is what it would carry if the click were ignored.
  const chosen = PRIORITIES.find((value) => value !== DEFAULT_PRIORITY)
  expect(chosen, 'the vocabulary offers no priority other than the default').toBeTruthy()
  const chosenButton = priorityField.getByRole('button', { name: chosen, exact: true })
  await chosenButton.click()
  await expect(chosenButton).toHaveClass(/prio-seg__btn--on/)

  await page.getByRole('button', { name: 'Create work item' }).click()

  await expect(page.getByText(title)).toBeVisible()

  // The round trip: picker → POST /api/items → the work_item CHECK constraint the
  // same vocabulary builds → the board card. Only the chosen value can appear here.
  const card = page.locator('.card').filter({ hasText: title })
  await expect(card).toHaveCount(1)
  await expect(card.locator('.card__priority')).toHaveText(chosen)

  await captureScreenshot(page, 'create-item')
})
