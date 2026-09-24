// WCAG AA contrast audit for HZ-25's dark palette — replaces "manually
// eyeball it" with a real gate. Covers every element the guardrail names
// (agent color chips, priority labels, gate buttons, step-status states)
// against both themes, using the same hex values as index.css's token
// blocks (see theme-tokens.js for why this is a separate JS mirror).

import { describe, expect, test } from 'vitest'
import { LIGHT, DARK } from './theme-tokens'

function expandHex(hex) {
  const h = hex.replace('#', '')
  return h.length === 3
    ? h
        .split('')
        .map((c) => c + c)
        .join('')
    : h
}

function srgbToLinear(c) {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

function relativeLuminance(hex) {
  const h = expandHex(hex)
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

function contrastRatio(hexA, hexB) {
  const lA = relativeLuminance(hexA)
  const lB = relativeLuminance(hexB)
  const lighter = Math.max(lA, lB)
  const darker = Math.min(lA, lB)
  return (lighter + 0.05) / (darker + 0.05)
}

const AA_NORMAL = 4.5
const AA_LARGE = 3.0

// [fg token, bg token, min ratio, description]
function pairs(t) {
  return [
    // ---- agent color chips (step-card__agent text/dot, activity avatar) ----
    // .step-card__agent's own background is var(--surface), not --surface-alt.
    [t.primaryInk, t.surface, AA_NORMAL, 'PM/Ensemble agent chip text on step-card'],
    [t.warningInk, t.surface, AA_NORMAL, 'QA agent chip text on step-card'],
    [t.architectInk, t.surface, AA_NORMAL, 'Architect agent chip text on step-card'],
    [t.successInk, t.surface, AA_NORMAL, 'Eng agent chip text on step-card'],
    [t.dangerInk, t.surface, AA_NORMAL, 'DevOps agent chip text on step-card'],
    [t.agentHumanInk, t.surface, AA_NORMAL, 'Review/Human agent chip text on step-card'],
    [t.white, t.primary, AA_NORMAL, 'PM/Ensemble avatar initials on avatar bg'],
    [t.white, t.warning, AA_NORMAL, 'QA avatar initials on avatar bg'],
    [t.white, t.brandDeep, AA_NORMAL, 'Architect avatar initials on avatar bg'],
    [t.white, t.success, AA_NORMAL, 'Eng avatar initials on avatar bg'],
    [t.white, t.danger, AA_NORMAL, 'DevOps avatar initials on avatar bg'],
    [t.white, t.agentHuman, AA_NORMAL, 'Review/Human avatar initials on avatar bg'],
    [t.white, t.mutedSolid, AA_NORMAL, 'Horizon system-event avatar initials on avatar bg'],

    // ---- priority labels (tracker__priority text on the header panel) ----
    [t.dangerInk, t.surface, AA_NORMAL, 'Critical priority label'],
    [t.warningInk, t.surface, AA_NORMAL, 'High priority label'],
    [t.primaryInk, t.surface, AA_NORMAL, 'Medium priority label'],
    [t.muted, t.surface, AA_NORMAL, 'Low priority label'],

    // ---- gate buttons ----
    [t.white, t.success, AA_NORMAL, 'Approve / btn-gate-approve label'],
    [t.dangerInk, t.surface, AA_NORMAL, 'Send back / btn-gate-reject label'],
    [t.deep, t.subtle, AA_NORMAL, 'Approve with comments / btn-gate-feedback label'],
    [t.primaryInk, t.primaryBg, AA_NORMAL, 'Request changes / btn-step-feedback label'],

    // ---- step-status states ----
    [t.white, t.success, AA_NORMAL, 'step__icon--done glyph'],
    [t.white, t.primary, AA_NORMAL, 'step__icon--active glyph'],
    [t.white, t.warning, AA_NORMAL, 'step__icon--awaiting glyph'],
    [t.white, t.danger, AA_NORMAL, 'step__icon--blocked glyph'],
    [t.primaryInk, t.activeBg, AA_NORMAL, 'active step meta text on step-card--active'],
    [t.warningInk, t.warningBgSoft, AA_NORMAL, 'awaiting step meta text on step-card--awaiting'],
    [t.dangerInk, t.dangerBgSoft, AA_NORMAL, 'blocked step meta text on step-card--blocked'],

    // ---- status pills (board card + tracker header) ----
    [t.successInk, t.successBg, AA_NORMAL, 'Closed status pill'],
    [t.dangerInk, t.dangerBg, AA_NORMAL, 'Changes requested status pill'],
    [t.mutedStrong, t.chip, AA_NORMAL, 'Paused status pill'],
    [t.warningInk, t.warningBg, AA_NORMAL, 'Awaiting status pill'],
    [t.primaryInk, t.primaryBg, AA_NORMAL, 'Agent working status pill'],

    // ---- base ink / meta text ----
    [t.deep, t.canvas, AA_NORMAL, 'body text on page background'],
    [t.deep, t.surface, AA_NORMAL, 'body text on card/panel surface'],
    [t.muted, t.surface, AA_NORMAL, 'meta text on card/panel surface'],
    [t.textSecondary, t.surface, AA_NORMAL, 'description text on panel surface'],
    [t.adminWarningText, t.adminWarningBg, AA_NORMAL, 'agent-definitions global warning banner'],
  ]
}

// These specific light-mode pairs were already below AA before HZ-25 — the
// exact hex values existed in index.css/domain files pre-dark-mode, just as
// literals instead of tokens. The guardrail requires light mode stay
// pixel-identical when the toggle is off, so this refactor can't touch
// them; fixing them is a separate, pre-existing accessibility issue.
// Dark mode does NOT inherit these gaps (see the assertions below) — the
// point of this list is to stop the new dark work from being blamed for an
// old light-mode bug, not to excuse dark mode from the same bar.
const KNOWN_LIGHT_MODE_GAPS = new Set([
  'QA avatar initials on avatar bg',
  'Horizon system-event avatar initials on avatar bg',
  'Low priority label',
  'step__icon--awaiting glyph',
  'awaiting step meta text on step-card--awaiting',
  'Paused status pill',
  'Awaiting status pill',
  'meta text on card/panel surface',
])

describe.each([
  ['light', LIGHT],
  ['dark', DARK],
])('%s theme — WCAG AA contrast', (themeName, tokens) => {
  test.each(pairs(tokens))('%s vs %s (min %s) — %s', (fg, bg, min, label) => {
    const ratio = contrastRatio(fg, bg)
    if (themeName === 'light' && KNOWN_LIGHT_MODE_GAPS.has(label)) {
      expect(ratio, `${label} regressed further below AA (${ratio.toFixed(2)}:1) — that's new, not pre-existing`).toBeGreaterThanOrEqual(2)
      return
    }
    expect(ratio, `${label}: ${fg} on ${bg} = ${ratio.toFixed(2)}:1, needs ${min}:1`).toBeGreaterThanOrEqual(min)
  })
})

test('dark mode does not inherit the known pre-existing light-mode gaps', () => {
  for (const [fg, bg, min, label] of pairs(DARK)) {
    if (!KNOWN_LIGHT_MODE_GAPS.has(label)) continue
    const ratio = contrastRatio(fg, bg)
    expect(ratio, `${label} still fails AA in dark mode (${ratio.toFixed(2)}:1)`).toBeGreaterThanOrEqual(min)
  }
})

test('large-text threshold sanity check', () => {
  expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0)
  expect(AA_LARGE).toBeLessThan(AA_NORMAL)
})
