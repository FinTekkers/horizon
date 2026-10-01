// HZ-179: a personal API token created from the Admin page works as
// `Authorization: Bearer` on a cookie-less request, and revoking it from the
// same page makes the very next request 401. The server-side matrix lives in
// server/test/api-tokens.test.mjs; this is the real UI→server path.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'

test('create a token in Admin, call the API with it, revoke it, and it stops working', async ({ page, playwright, baseURL }) => {
  await page.goto('/admin')
  const panel = page.locator('.api-tokens')
  await expect(panel).toBeVisible({ timeout: 10_000 })

  await panel.getByPlaceholder('Token name, e.g. ci-bot').fill('e2e-script')
  await expect(panel.getByLabel('Expires in days')).toHaveValue('90')
  await panel.getByRole('button', { name: 'Create token' }).click()

  const raw = (await panel.locator('.api-tokens__raw').textContent()).trim()
  expect(raw).toMatch(/^hz_[A-Za-z0-9_-]{43}$/)
  const row = panel.locator('.api-token-row', { hasText: 'e2e-script' })
  await expect(row).toContainText(`…${raw.slice(-4)}`)
  await captureScreenshot(page, 'api-tokens')

  // A fresh request context: no storageState, so no session cookie at all.
  const api = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
  try {
    expect((await api.get('/api/items')).status()).toBe(401)
    const ok = await api.get('/api/items', { headers: { authorization: `Bearer ${raw}` } })
    expect(ok.status()).toBe(200)

    await panel.getByRole('button', { name: 'Done' }).click()
    await expect(page.locator('body')).not.toContainText(raw)

    page.once('dialog', (dialog) => dialog.accept())
    await row.getByRole('button', { name: 'Revoke' }).click()
    await expect(row).toHaveCount(0)

    const revoked = await api.get('/api/items', { headers: { authorization: `Bearer ${raw}` } })
    expect(revoked.status()).toBe(401)
    expect(await revoked.json()).toEqual({ error: 'invalid_token' })
  } finally {
    await api.dispose()
  }
})
