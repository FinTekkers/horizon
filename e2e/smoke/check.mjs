#!/usr/bin/env node
// Deep-verification smoke check (HZ-22): loads a URL in a real headless
// browser and confirms expected content actually rendered in the DOM — not
// just that the endpoint returned 200. This is the tool the DevOps role
// (farm/roles/devops.md) is instructed to invoke after a deploy, and the
// exit code is meant to be checked directly by calling code (never just the
// LLM's own report of what it saw) — see check.test.mjs for the pass/fail
// contract this relies on.
//
// Usage: node smoke/check.mjs <url> <expected-text> [screenshot-path]
// Exit 0 + "SMOKE_RESULT=pass" if <expected-text> is visible in the
// rendered page within the timeout; exit 1 + "SMOKE_RESULT=fail: <reason>"
// otherwise (navigation error, timeout, or text never appears).
//
// Requires a downloaded Chromium build (same requirement as the e2e suite —
// `npx --prefix e2e playwright install chromium`, once).

import { chromium } from '@playwright/test'

const NAV_TIMEOUT_MS = 15_000
const TEXT_TIMEOUT_MS = 10_000

async function checkRenders(url, expectedText, screenshotPath) {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' })
    await page.getByText(expectedText, { exact: false }).first().waitFor({ timeout: TEXT_TIMEOUT_MS })
    if (screenshotPath) {
      await page.screenshot({ path: screenshotPath }).catch(() => {})
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err.message.split('\n')[0] }
  } finally {
    await browser.close()
  }
}

async function main() {
  const [url, expectedText, screenshotPath] = process.argv.slice(2)
  if (!url || !expectedText) {
    console.error('usage: node smoke/check.mjs <url> <expected-text> [screenshot-path]')
    return 2
  }
  const result = await checkRenders(url, expectedText, screenshotPath)
  if (result.ok) {
    console.log(`SMOKE_RESULT=pass — "${expectedText}" rendered at ${url}`)
    return 0
  }
  console.log(`SMOKE_RESULT=fail: ${result.reason} (${url}, expected "${expectedText}")`)
  return 1
}

main().then((code) => process.exit(code))
