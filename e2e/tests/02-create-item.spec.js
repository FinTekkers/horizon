import { test, expect } from '../fixtures/test-base.js'

test('creating a work item via the modal adds it to the board', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '+ New work item' }).click()

  const title = `E2E created item ${Date.now()}`
  await page.getByPlaceholder(/One line naming the work/).fill(title)
  await page
    .getByPlaceholder(/Risk managers get a live view/)
    .fill('A clear outcome description for this e2e journey, well over ten characters.')
  await page.getByPlaceholder(/Limit breaches acknowledged/).fill('A measurable success metric for e2e verification.')
  await page.getByRole('button', { name: 'Create work item' }).click()

  await expect(page.getByText(title)).toBeVisible()
})
