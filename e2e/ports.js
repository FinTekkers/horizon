// Port choice for playwright.config.js, split out so it can be unit-tested
// (ports.test.mjs) without loading Playwright.
//
// Each worktree gets an offset 0-999 hashed from its path; the UI and the
// server each add it to their own base, giving two disjoint 1000-port windows
// (UI 4351-5350, server 3057-4056). Some of those ports are on Chromium's
// restricted list, and every page.goto to one fails with net::ERR_UNSAFE_PORT
// (HZ-595's worktree hashed to UI 5061: 119 of 120 tests failed on every
// resume). pickOffset moves such an offset to the next one that is safe for
// both ports; every other offset is returned unchanged.

export const UI_BASE = 4351
export const SERVER_BASE = 3057
export const OFFSET_RANGE = 1000

// kRestrictedPorts, copied from
// https://chromium.googlesource.com/chromium/src.git/+/refs/heads/main/net/base/port_util.cc
// Only 3659, 4045 (server) and 5060, 5061 (UI) fall inside our windows; the
// full list is kept so a change to the bases stays safe.
export const RESTRICTED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
])

const isSafe = (offset) =>
  !RESTRICTED_PORTS.has(UI_BASE + offset) && !RESTRICTED_PORTS.has(SERVER_BASE + offset)

export function pickOffset(offset) {
  for (let step = 0; step < OFFSET_RANGE; step++) {
    const candidate = (offset + step) % OFFSET_RANGE
    if (isSafe(candidate)) return candidate
  }
  throw new Error('no e2e port offset is free of Chromium-restricted ports')
}
