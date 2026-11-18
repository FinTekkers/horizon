// HO-877: the sl backend's land — exactly once, through farmd's /vcs/land.
// The registry (backends/index.js) hands it out as forRepo(repo).vcs.land for
// an sl repo on a server with a farm. Its one caller is the sl branch of app.js's Accept,
// which calls it inside the item's premerge gate_action claim.
//
// land(item, { claim, log, checkCommands, checksWaiver, testEnvFile }) runs,
// in order, and stops at the first that answers:
//   1. Claim held. The premerge claim `claim.token` must still be running; the
//      check renews its lease (store.renewGateActionLease is true only for the
//      claiming run). Re-checked before every farmd request.
//   2. Gate Accepted. A fresh read must show the item on Accept the code and
//      not abandoned. Re-checked after the status read.
//   3. Already landed. landed_hash set: that hash, no farmd request at all.
//   4. Diff pinned. work_item.diff_id, as stored at submit, is the only diff
//      this lands. None: refused.
//   5. Status read (/vcs/review-status, naming the pinned diff). Another diff:
//      refused. A landed commit: that hash, no land request — the crash after
//      a push but before the DB write. Not Accepted: refused.
//   6. Land (/vcs/land, naming the pinned diff), after renewing the claim's
//      lease past the request's own time limit.
//   7. An unclear outcome (timeout, network error, 5xx, or a push farmd could
//      not see on master yet) reads the status once more: a landed commit is
//      that hash; otherwise it throws, and nothing is pushed again.
//
// Resolves { hash, diff, alreadyLanded, refused }. `refused` is null, or
// { code, reason } when nothing was sent to land — unlike GitHub's land (the
// VCS port in test/contracts/vcs.contract.mjs), which rejects for a refusal.
// app.js shows the reason on the item and records the hash with
// store.markLanded; this module writes neither. Rejects for a failure.
//
// The guards live here, beside the farmd calls, so no other caller can reach
// /vcs/land without them.

import * as store from '../../store.js'
import { ACCEPT_GATE_INDEX } from '../../../../domain/js/lifecycle.js'
import { PREMERGE_CHECK_TIMEOUT_MS } from '../../config.js'
import { createSlReview, farmdFetch, requestBody, STATUS_TIMEOUT_MS } from './review.js'
import { ACCEPTED } from '../../landRules.js'

export const LAND_PATH = '/vcs/land'

// farmd's test rebase gets the pre-merge checks' own limit. Around it farmd
// runs sl pull, jf sync, sl push and sl pull again, each with its own cap
// (farm/vcs/sl.py PULL/JF/PUSH_TIMEOUT_S: 900 + 600 + 900 + 900 s), so the
// request may take that much longer, and the claim's lease covers all of it.
const LAND_TIMEOUT_S = Math.max(1, Math.round(PREMERGE_CHECK_TIMEOUT_MS / 1000))
const SL_STEPS_MS = (900 + 600 + 900 + 900) * 1000
export const LAND_REQUEST_MS = PREMERGE_CHECK_TIMEOUT_MS + SL_STEPS_MS

const COMMIT = /^[0-9a-f]{40}$/

// A farmd answer that says, for sure, nothing was pushed.
const isRefusal = (err) => typeof err?.code === 'string' && Number.isInteger(err?.status) && err.status >= 400 && err.status < 500

export function createSlVcs({ farmFetch = farmdFetch, review = createSlReview({ farmFetch }) } = {}) {
  async function land(item, { claim, log, checkCommands = null, checksWaiver = null, testEnvFile = null } = {}) {
    const id = item.id
    let fresh = store.getItem(id)
    const diff = fresh?.diff_id ?? null
    const refuse = (code, reason) => ({ hash: null, diff, alreadyLanded: false, refused: { code, reason } })
    const landed = (hash, alreadyLanded) => ({ hash, diff, alreadyLanded, refused: null })
    const held = (ms) => typeof claim?.token === 'string' && store.renewGateActionLease(id, 'premerge', claim.token, ms)
    const detail = (text) => store.setGateActionDetail(id, 'premerge', claim.token, text)
    const atGate = () => {
      fresh = store.getItem(id)
      return fresh != null && fresh.cursor === ACCEPT_GATE_INDEX && fresh.abandoned_at == null
    }
    const claimLost = () => refuse('claim_lost', 'the Accept claim was lost before landing')
    const gateNotAccepted = () => refuse('gate_not_accepted', 'the item is no longer at Accept the code')

    if (!held(STATUS_TIMEOUT_MS)) return claimLost()
    if (!atGate()) return gateNotAccepted()
    if (fresh.landed_hash) return landed(fresh.landed_hash, true)
    if (!diff) return refuse('no_diff', `${id} has no submitted diff`)

    // Step 5: the pinned diff's review status.
    detail(`reading ${diff}'s review status`)
    let status
    try {
      status = await review.status(fresh)
    } catch (err) {
      if (isRefusal(err)) return refuse(err.code, `farmd refused the review status read: ${err.message}`)
      throw err
    }
    if (!held(STATUS_TIMEOUT_MS)) return claimLost()
    if (!atGate()) return gateNotAccepted()
    if (fresh.landed_hash) return landed(fresh.landed_hash, true)
    if (status.diff !== diff) return refuse('diff_mismatch', `farmd reports ${status.diff}, but this item is pinned to ${diff}`)
    if (status.landedCommit) return landed(status.landedCommit, true)
    if (status.status !== ACCEPTED) return refuse('diff_not_accepted', `${diff} is ${status.status}, not ${ACCEPTED}`)

    // Step 7, for the land below: an unclear outcome reads the status once
    // and never sends a second land.
    const afterUnclear = async (why) => {
      log?.warn?.(`sl land of ${diff} for ${id} is unclear (${why}); reading its status once`)
      let again = null
      try {
        if (held(STATUS_TIMEOUT_MS)) again = await review.status(fresh)
      } catch (err) {
        log?.warn?.(`sl status re-read for ${id} failed: ${err.message}`)
      }
      if (again?.diff === diff && again.landedCommit) return landed(again.landedCommit, false)
      throw new Error(`the land of ${diff} did not finish (${why}) and ${diff} is not on master — press Accept again`)
    }

    // Step 6: the one land request.
    if (!held(LAND_REQUEST_MS)) return claimLost()
    detail(`landing ${diff} on master`)
    let result
    try {
      result = await farmFetch(
        LAND_PATH,
        requestBody(fresh, {
          diff,
          check_commands: checkCommands,
          checks_waiver: checksWaiver,
          test_env_file: testEnvFile,
          timeout_s: LAND_TIMEOUT_S,
        }),
        { timeoutMs: LAND_REQUEST_MS },
      )
    } catch (err) {
      if (isRefusal(err)) return refuse(err.code, `farmd did not land ${diff}: ${err.message}`)
      return afterUnclear(err.message)
    }
    if (typeof result?.commit === 'string' && COMMIT.test(result.commit)) return landed(result.commit, result.already_landed === true)
    return afterUnclear(`farmd pushed ${diff} but did not name its commit`)
  }

  return Object.freeze({ land })
}
