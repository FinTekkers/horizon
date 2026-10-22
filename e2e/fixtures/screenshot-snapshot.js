// HZ-548: the canned GitHub side of an item's screenshot publish, shared by
// 52-screenshot-approvals and 54-screenshot-viewer: the publish's results.json,
// its tree, the baseline tree and the blob bytes that
// /api/test/screenshot-snapshot serves in place of GitHub.

import { expect } from '@playwright/test'

export const SHOT_DIR = 'e2e/__screenshots__'

export const sha = (n) => String(n).padStart(2, '0').repeat(20)
const entry = (n) => ({ sha: sha(n), size: 120 })

// Blob sha → base64 bytes, from four PNGs. 01 is the board's baseline, 02 its
// first capture, 03 the diff (and the unchanged home), 04 gates and old; 05 is
// a re-captured board.
export const blobsOf = (pngs) => ({ [sha(1)]: pngs[0], [sha(2)]: pngs[1], [sha(3)]: pngs[2], [sha(4)]: pngs[3], [sha(5)]: pngs[3] })

// board changed (baseline, new, diff), gates new (new only), home the same
// (not listed), old removed (baseline only).
const RESULTS = {
  version: 1,
  baseline: 'b'.repeat(40),
  shots: [
    { name: 'board', status: 'changed', diffRatio: 0.042, diff: `${SHOT_DIR}/diff/board.png`, error: null },
    { name: 'gates', status: 'new', diffRatio: null, diff: null, error: null },
    { name: 'home', status: 'same', diffRatio: 0, diff: null, error: null },
    { name: 'old', status: 'removed', diffRatio: null, diff: null, error: null },
  ],
}
const BASELINE_FILES = { [`${SHOT_DIR}/board.png`]: entry(1), [`${SHOT_DIR}/home.png`]: entry(3), [`${SHOT_DIR}/old.png`]: entry(4) }

// An item's latest publish; `board` is the blob its new board shot has.
export const publication = (commit, board = 2) => ({
  commit,
  results: RESULTS,
  files: {
    [`${SHOT_DIR}/board.png`]: entry(board),
    [`${SHOT_DIR}/diff/board.png`]: entry(3),
    [`${SHOT_DIR}/gates.png`]: entry(4),
    [`${SHOT_DIR}/home.png`]: entry(3),
  },
  baselineFiles: BASELINE_FILES,
})

// snapshots: `${repo}#${itemId}` → a publication, or null for none.
export async function seedScreenshotSnapshot(request, snapshots, blobs) {
  const res = await request.post('/api/test/screenshot-snapshot', { data: { snapshots, blobs } })
  expect(res.ok()).toBeTruthy()
}

export async function clearScreenshotSnapshot(request) {
  await request.post('/api/test/screenshot-snapshot', { data: { snapshots: null, blobs: null } })
}
