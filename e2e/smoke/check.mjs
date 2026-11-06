#!/usr/bin/env node
// Deep-verification smoke check (HZ-22): loads a URL in a real headless
// browser and confirms expected content actually rendered in the DOM — not
// just that the endpoint returned 200. This is the tool the DevOps role
// (farm/roles/devops.md) is instructed to invoke after a deploy, and the
// exit code is meant to be checked directly by calling code (never just the
// LLM's own report of what it saw) — see check.test.mjs for the pass/fail
// contract this relies on.
//
// Usage: node smoke/check.mjs <url> <expected-text> [screenshot-path] [--live=<json>]
// Exit 0 + "SMOKE_RESULT=pass" if <expected-text> is visible in the
// rendered page within the timeout; exit 1 + "SMOKE_RESULT=fail: <reason>"
// otherwise (navigation error, timeout, or text never appears).
//
// HZ-789: --live=<json> is a page the repo declares in .horizon/smoke.json
// (farm/smoke_config.py validates it and builds this argument). After the
// text check, at least one element matching its liveValue selector must
// show a value; a page whose declared sections all show their emptyText
// fails, naming them. Without --live the check and its output are as before.
//
// Requires a downloaded Chromium build (same requirement as the e2e suite —
// `npx --prefix e2e playwright install chromium`, once).

import { chromium } from '@playwright/test'

const NAV_TIMEOUT_MS = 15_000
const TEXT_TIMEOUT_MS = 10_000
// Navigation + text + live data stays inside farm/step_agent.py's 60s
// SMOKE_CHECK_TIMEOUT_S.
const LIVE_TIMEOUT_MS = 15_000
const LIVE_POLL_MS = 250
const LIVE_VALUE_MAX_CHARS = 60
const MAX_MARKER_CHARS = 200
const LIVE_PREFIX = '--live='
// Defensive re-check of farm/smoke_config.py's NON_CSS_SELECTOR — keep the
// two identical. A marker only ever reaches page.locator() as CSS.
const NON_CSS_SELECTOR = /^\s*(?:[A-Za-z_-]+=|\/\/|\.\.|["'])|>>|internal:/

function isMarker(value) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_MARKER_CHARS
}

function isSelector(value) {
  return isMarker(value) && !NON_CSS_SELECTOR.test(value)
}

// The field that makes `live` unusable, or null. Names the field, never
// the value.
function badLiveField(live) {
  if (!live || typeof live !== 'object' || Array.isArray(live)) return '--live'
  if (!isSelector(live.liveValue)) return 'liveValue'
  if (!Array.isArray(live.sections) || live.sections.length === 0) return 'sections'
  for (const [i, section] of live.sections.entries()) {
    if (!section || typeof section !== 'object') return `sections[${i}]`
    if (!isMarker(section.name)) return `sections[${i}].name`
    if (!isSelector(section.selector)) return `sections[${i}].selector`
    if (!Array.isArray(section.emptyText) || section.emptyText.length === 0) return `sections[${i}].emptyText`
    const k = section.emptyText.findIndex((text) => !isMarker(text))
    if (k !== -1) return `sections[${i}].emptyText[${k}]`
  }
  return null
}

function oneLine(text) {
  return text.replace(/\s+/g, ' ').trim()
}

// The first visible liveValue element's text, unless it is blank or reads
// as any declared section's emptyText (the union: a placeholder carrying the
// live marker is not a live value).
async function firstLiveValue(page, live, emptyTexts) {
  for (const el of await page.locator(live.liveValue).all()) {
    const text = await el.isVisible().then((visible) => (visible ? el.innerText() : ''), () => '')
    const value = oneLine(text)
    if (value && !emptyTexts.some((empty) => value.includes(empty))) return value
  }
  return null
}

// 'missing' (no element), 'empty' (shows one of its emptyText) or 'pending'.
async function sectionState(page, section) {
  const found = page.locator(section.selector)
  if ((await found.count()) === 0) return 'missing'
  const text = await found.first().innerText().catch(() => '')
  return section.emptyText.some((empty) => text.includes(empty)) ? 'empty' : 'pending'
}

async function checkLive(page, live) {
  const emptyTexts = live.sections.flatMap((section) => section.emptyText)
  const deadline = Date.now() + LIVE_TIMEOUT_MS
  for (;;) {
    const value = await firstLiveValue(page, live, emptyTexts)
    if (value !== null) return { ok: true, matched: live.liveValue, value }
    const states = await Promise.all(live.sections.map((section) => sectionState(page, section)))
    const named = (state) => live.sections.filter((_, i) => states[i] === state).map((section) => oneLine(section.name))
    if (states.every((state) => state === 'empty')) {
      return { ok: false, reason: `live data unavailable — every live section shows its unavailable or empty state: ${named('empty').join(', ')}` }
    }
    if (Date.now() >= deadline) {
      const groups = [['unavailable', named('empty')], ['not resolved', named('pending')], ['not found', named('missing')]]
        .filter(([, names]) => names.length)
        .map(([label, names]) => `${label}: ${names.join(', ')}`)
      return { ok: false, reason: `no live value within ${LIVE_TIMEOUT_MS / 1000}s — ${groups.join('; ')}` }
    }
    await page.waitForTimeout(LIVE_POLL_MS)
  }
}

async function checkRenders(url, expectedText, screenshotPath, live) {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' })
    await page.getByText(expectedText, { exact: false }).first().waitFor({ timeout: TEXT_TIMEOUT_MS })
    const result = live ? await checkLive(page, live) : { ok: true }
    if (screenshotPath) {
      await page.screenshot({ path: screenshotPath }).catch(() => {})
    }
    return result
  } catch (err) {
    return { ok: false, reason: err.message.split('\n')[0] }
  } finally {
    await browser.close()
  }
}

async function main() {
  const args = process.argv.slice(2)
  const liveArgs = args.filter((arg) => arg.startsWith(LIVE_PREFIX))
  const [url, expectedText, screenshotPath] = args.filter((arg) => !arg.startsWith(LIVE_PREFIX))
  if (!url || !expectedText || liveArgs.length > 1) {
    console.error('usage: node smoke/check.mjs <url> <expected-text> [screenshot-path] [--live=<json>]')
    return 2
  }
  let live = null
  if (liveArgs.length) {
    let bad
    try {
      live = JSON.parse(liveArgs[0].slice(LIVE_PREFIX.length))
      bad = badLiveField(live)
    } catch {
      bad = '--live'
    }
    if (bad) {
      console.log(`SMOKE_RESULT=fail: --live ${bad} is not a usable marker (plain CSS selector or text, at most ${MAX_MARKER_CHARS} characters) (${url}, expected "${expectedText}")`)
      return 1
    }
  }
  const result = await checkRenders(url, expectedText, screenshotPath, live)
  if (result.ok) {
    const shown = result.value === undefined ? '' : `; live value ${result.matched} = "${result.value.slice(0, LIVE_VALUE_MAX_CHARS)}"`
    console.log(`SMOKE_RESULT=pass — "${expectedText}" rendered at ${url}${shown}`)
    return 0
  }
  console.log(`SMOKE_RESULT=fail: ${result.reason} (${url}, expected "${expectedText}")`)
  return 1
}

main().then((code) => process.exit(code))
