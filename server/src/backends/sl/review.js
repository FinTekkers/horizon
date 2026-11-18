// HO-877: the sl backend's review side — an sl item's change is one
// Phabricator diff, submitted, read and landed by farmd's /vcs/* routes
// (farm/farmd.py over farm/vcs/sl.py). This server never runs sl, jf or any
// other subprocess for it: every call here is one farmd request.
//
//   submit(item, { summary, testPlan }) posts /vcs/submit and pins the diff it
//       names on the item (store.setDiffId). A diff other than the pinned one
//       is never adopted: it throws DiffChanged after one event naming both
//       diffs, and the item waits for a human to reset the pin.
//   status(item) posts /vcs/review-status for the pinned work_item.diff_id and
//       resolves { diff, status, landedCommit }. landedCommit is the master
//       commit carrying that diff, or null when it has not landed.
//   refreshStatus(itemId) reads status() and records it on the item
//       (store.recordDiffStatus). server.js injects it, through the
//       registry's refreshReviewStatus, into the Accept caretaker
//       (caretakerActor.setReviewStatus), which reads the stored value and so
//       never calls sl itself.
//
// These are not methods of the shared Review port (backends/github.js's review
// group, whose sl placeholders backends/sl.js keeps): GitHub has no diff pin
// and no review status read. backends/sl/vcs.js's land and the caretaker are
// their callers.
//
// `farmFetch` is injectable: tests pass a stub that records every request. The
// default is orchestrator.js's farmFetch (its long-request transport is what a
// land of up to an hour needs), loaded on first use so this module adds no
// import cycle, and refused when no farm is configured.

import { FARM_URL } from '../../config.js'
import * as store from '../../store.js'

export const SUBMIT_PATH = '/vcs/submit'
export const REVIEW_STATUS_PATH = '/vcs/review-status'
const SUBMIT_TIMEOUT_MS = 20 * 60 * 1000
export const STATUS_TIMEOUT_MS = 2 * 60 * 1000

const DIFF = /^D\d+$/
const COMMIT = /^[0-9a-f]{40}$/

export async function farmdFetch(path, body, opts) {
  if (!FARM_URL) throw new Error('no farm is configured')
  const { farmFetch } = await import('../../orchestrator.js')
  return farmFetch(path, body, opts)
}

// farmd names an sl repo by its bare name (farm/vcs/sl.py REPO_RE); Horizon
// keeps the connected repo's full name, so the last path segment is sent.
export function slRepoName(repo) {
  return String(repo ?? '').split('/').pop()
}

export function requestBody(item, extra = {}) {
  return { backend: 'sl', repo: slRepoName(item.repo), item: { id: item.id }, ...extra }
}

export function createSlReview({ farmFetch = farmdFetch } = {}) {
  async function status(item) {
    const diff = item?.diff_id
    if (typeof diff !== 'string' || !DIFF.test(diff)) throw new Error(`${item?.id ?? 'the item'} has no submitted diff`)
    const data = await farmFetch(REVIEW_STATUS_PATH, requestBody(item, { diff }), { timeoutMs: STATUS_TIMEOUT_MS })
    if (typeof data?.diff !== 'string' || typeof data?.status !== 'string' || !data.status.trim()) {
      throw new Error('farmd answered the review status without a diff and status')
    }
    const landed = data.landed_commit ?? null
    if (landed !== null && (typeof landed !== 'string' || !COMMIT.test(landed))) {
      throw new Error('farmd answered a landed commit that is not a 40-hex commit')
    }
    return { diff: data.diff, status: data.status.trim(), landedCommit: landed }
  }

  async function submit(item, { summary = '', testPlan = '' } = {}) {
    const data = await farmFetch(SUBMIT_PATH, requestBody(item, { summary, test_plan: testPlan }), { timeoutMs: SUBMIT_TIMEOUT_MS })
    if (typeof data?.diff !== 'string' || !DIFF.test(data.diff)) throw new Error('farmd answered the submit without a D<number> diff')
    try {
      store.setDiffId(item.id, data.diff)
    } catch (err) {
      if (err?.code === 'diff_changed') {
        store.addEvent(item.id, {
          who: 'Horizon',
          text: `submitted ${err.found}, but this item is pinned to ${err.pinned} — Horizon lands only ${err.pinned}, so nothing more happens until a human resets the pin`,
          color: '#9C333E',
          initials: 'HZ',
        })
        store.notifyChange()
      }
      throw err
    }
    return { diff: data.diff, commit: typeof data.commit === 'string' ? data.commit : null, updated: data.updated === true }
  }

  async function refreshStatus(itemId) {
    const item = store.getItem(itemId)
    if (!item?.diff_id) return null
    const read = await status(item)
    if (read.diff !== item.diff_id) throw new Error(`farmd answered ${read.diff}, not the pinned ${item.diff_id}`)
    store.recordDiffStatus(item.id, item.diff_id, read.status)
    return read.status
  }

  return Object.freeze({ status, submit, refreshStatus })
}

const slReview = createSlReview()

// The registry's refreshReviewStatus for an sl item: the status it recorded.
export function refreshDiffStatus(itemId) {
  return slReview.refreshStatus(itemId)
}

// The registry's submitDiff for an sl item: orchestrator.js's implement
// result submits the change and pins the diff farmd names.
export function submitDiff(item, opts) {
  return slReview.submit(item, opts)
}
