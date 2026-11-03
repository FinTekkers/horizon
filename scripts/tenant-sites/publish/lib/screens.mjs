import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { PublishError } from './errors.mjs'

export const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 } },
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
}

// Full-page desktop and mobile screenshots of the live site. playwright is
// loaded here, not at the top of the file, so tests and --no-screens runs
// need no install.
export async function captureScreens({ url, outDir }) {
  let chromium
  try {
    ({ chromium } = await import('playwright'))
  } catch {
    throw new PublishError('playwright is not installed: run `npm --prefix scripts/tenant-sites/publish install` (or pass --no-screens)')
  }
  await mkdir(outDir, { recursive: true })
  const browser = await chromium.launch()
  try {
    const shots = {}
    for (const [name, options] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext(options)
      const page = await context.newPage()
      await page.goto(url, { waitUntil: 'networkidle' })
      shots[name] = path.join(outDir, `${name}.png`)
      await page.screenshot({ path: shots[name], fullPage: true })
      await context.close()
    }
    return shots
  } finally {
    await browser.close()
  }
}
