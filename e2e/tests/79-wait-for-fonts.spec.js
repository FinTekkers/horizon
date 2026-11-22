// HZ-942: waitForFonts (fixtures/test-base.js) does not return while a web
// font is still loading. A route holds a font file back for HOLD_MS; the
// helper must return only after the route released it, with the face loaded.
// No server state: the page is set from a string.

import { test, expect, waitForFonts } from '../fixtures/test-base.js'

const FONT_URL = 'https://fonts.e2e.invalid/held.ttf'
const HOLD_MS = 1500
// A 648-byte TrueType font, family "E2E Held": a .notdef and an "x", each a
// box. Built with fontTools' FontBuilder; small enough to keep inline.
const FONT_BASE64 =
  'AAEAAAAKAIAAAwAgT1MvMkVXRfwAAAEoAAAAYGNtYXAADADLAAABkAAAADRnbHlmTRZnoAAAAcwAAAAwaGVhZDDpqAQAAACsAAAANmhoZWEGpgOHAAAA5AAAACRobXR4BkAAAAAAAYgAAAAIbG9jYQAYAAwAAAHEAAAABm1heHAABAAGAAABCAAAACBuYW1l4XEpqAAAAfwAAABjcG9zdABfAAAAAAJgAAAAJgABAAAAAQAAQS2VOl8PPPUAAwPoAAAAAOcnsjQAAAAA5yeyNAAAAAADhAK8AAAAAwACAAAAAAAAAAEAAAMg/zgAAAPoAAAAZAOEAAEAAAAAAAAAAAAAAAAAAAACAAEAAAACAAQAAQAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwMgAZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAPz8/PwAAAHgAeAMgAAAAAAMgAMgAAAAAAAAAAAAAAAAAAAAgAAACWAAAA+gAAAAAAAIAAAADAAAAFAADAAEAAAAUAAQAIAAAAAQABAABAAAAeP//AAAAeP///4kAAQAAAAAAAAAMABgAAAABAAAAAAH0ArwAAwAAMREhEQH0Arz9RAABAAAAAAOEArwAAwAAMREhEQOEArz9RAAAAAQANgABAAAAAAABAAgAAAABAAAAAAACAAcACAADAAEECQABABAADwADAAEECQACAA4AH0UyRSBIZWxkUmVndWxhcgBFADIARQAgAEgAZQBsAGQAUgBlAGcAdQBsAGEAcgAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAWwAA'

test('waitForFonts returns only after a held-back font has loaded', async ({ page }) => {
  let releasedAt = null
  await page.route(FONT_URL, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS))
    releasedAt = Date.now()
    await route.fulfill({
      status: 200,
      contentType: 'font/ttf',
      headers: { 'access-control-allow-origin': '*' },
      body: Buffer.from(FONT_BASE64, 'base64'),
    })
  })

  await page.setContent(
    `<style>
      @font-face { font-family: 'E2E Held'; src: url('${FONT_URL}') format('truetype'); }
      #held { font-family: 'E2E Held', monospace; font-size: 20px; }
    </style>
    <span id="held">xxxx</span>`,
    { waitUntil: 'domcontentloaded' },
  )

  await waitForFonts(page)

  expect(releasedAt, 'waitForFonts returned before the font was released').not.toBeNull()
  const faces = await page.evaluate(() => [...document.fonts].map((face) => `${face.family}:${face.status}`))
  expect(faces).toEqual(['E2E Held:loaded'])
  // Each "x" is 1000 units of a 1000-unit em: 4 × 20px once the font is in.
  const box = await page.locator('#held').boundingBox()
  expect(box.width).toBeCloseTo(80, 0)
})
