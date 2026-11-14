// HO-843: driving an owner's one-command patch through the real app — a
// full approval at Approve the run, the patch route, the Run plan check, Impact
// review and Preflight completed as the farm completes them, and the PIN
// re-approval. Shared by task-approve-run-gate.test.mjs and
// run-plan-patch.test.mjs, each with its own database, app and stubbed farm.

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  APPROVE_RUN_GATE_INDEX,
  EXECUTE_STEP_INDEX,
  IMPACT_REVIEW_STEP_INDEX,
  PREFLIGHT_STEP_INDEX,
  RUN_PLAN_STEP_INDEX,
  stepKeyAt,
} from '../../../domain/js/lifecycle.js'
import { CLEAN_REHEARSAL } from './preflight.mjs'

export const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

export const patchPlanArtifact = (commands, extra = {}) =>
  '## Commands\n1. backfill\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '.', commands, budget_minutes: 20, ...extra }, null, 2) +
  '\n```'

const PREFLIGHT_PASSED = { passed: true, runner: 'host', run_user: 'ubuntu', unmet: [] }

export function runPlanPatchHarness({ db, store, orchestrator, app, dispatches, session, pin }) {
  const withPin = { ...session, 'x-human-key': pin }
  const row = (id) =>
    db
      .prepare(
        'SELECT cursor, paused, approved_plan_hash, approved_runner, approved_command_hashes_json, approved_frame_hash, command_patch_json FROM work_item WHERE id = ?',
      )
      .get(id)
  const hashes = (id) => JSON.parse(row(id).approved_command_hashes_json ?? 'null')
  const patchState = (id) => JSON.parse(row(id).command_patch_json ?? 'null')
  const activeRun = (id) => db.prepare("SELECT id, step_index FROM step_run WHERE item_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(id) ?? null
  const decisions = (id) =>
    db.prepare("SELECT * FROM gate_decision WHERE item_id = ? AND step_index = ? AND decision = 'approved' ORDER BY id").all(id, APPROVE_RUN_GATE_INDEX)
  const view = (id) => store.itemViewById(id)

  async function waitFor(fn, what) {
    for (let i = 0; i < 150; i += 1) {
      const value = fn()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  // The newest /steps/run payload for the item's step, once it was sent.
  const dispatchFor = (id, stepIndex) =>
    waitFor(
      () => dispatches.filter((d) => d.url.endsWith('/steps/run') && d.body?.item?.id === id && d.body?.step?.index === stepIndex).at(-1)?.body,
      `the ${stepKeyAt(stepIndex)} dispatch of ${id}`,
    )

  const approve = (id, payload = {}, headers = withPin) =>
    app.inject({ method: 'POST', url: `/api/items/${id}/move`, headers, payload: { action: 'approve', from: stepKeyAt(APPROVE_RUN_GATE_INDEX), ...payload } })

  const patch = (id, payload, headers = session) => app.inject({ method: 'POST', url: `/api/items/${id}/run-plan/patch`, headers, payload })

  // The plan at the gate approved in full; the item is left at Execute with
  // no job running, as after a Stop.
  async function approveInFull(id) {
    const shown = view(id)
    const res = await approve(id, { planHash: shown.runPlan.hash, runner: shown.runPlan.runner })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(row(id).cursor, EXECUTE_STEP_INDEX)
    orchestrator.cancel(id)
    await waitFor(() => !activeRun(id), `no active run on ${id}`)
  }

  // A patch from Execute of command `index` (0-based) on the approved plan.
  const patchAtExecute = (id, index, command, headers = session) =>
    patch(id, { from: stepKeyAt(EXECUTE_STEP_INDEX), planHash: row(id).approved_plan_hash, index, command }, headers)

  async function completeStep(id, stepIndex, artifacts) {
    const run = await waitFor(() => {
      const active = activeRun(id)
      return active?.step_index === stepIndex ? active : null
    }, `an active ${stepKeyAt(stepIndex)} run on ${id}`)
    return orchestrator.completeFarmRun(run.id, { summary: `${stepKeyAt(stepIndex)} done`, artifacts })
  }

  async function failStep(id, stepIndex, error) {
    const run = await waitFor(() => {
      const active = activeRun(id)
      return active?.step_index === stepIndex ? active : null
    }, `an active ${stepKeyAt(stepIndex)} run on ${id}`)
    return orchestrator.failFarmRun(run.id, error)
  }

  // Run plan hands the patched artifact back byte for byte, Impact review
  // passes, Preflight passes with a clean rehearsal: the item is at the gate.
  async function driveToGate(id) {
    await completeStep(id, RUN_PLAN_STEP_INDEX, { artifact_md: patchState(id).artifact })
    await completeStep(id, IMPACT_REVIEW_STEP_INDEX, { artifact_md: '## Verdict\n**pass**' })
    await completeStep(id, PREFLIGHT_STEP_INDEX, { artifact_md: '## Preflight', preflight: PREFLIGHT_PASSED, rehearsal: CLEAN_REHEARSAL })
    assert.equal(row(id).cursor, APPROVE_RUN_GATE_INDEX)
  }

  // The per-command re-approval exactly as the card sends it.
  function approveCommand(id, overrides = {}, headers = withPin) {
    const plan = view(id).runPlan
    return approve(
      id,
      { planHash: plan.hash, runner: plan.runner, commandIndex: plan.commandPatch?.index, commandHash: plan.commandPatch?.commandHash, ...overrides },
      headers,
    )
  }

  return { row, hashes, patchState, activeRun, decisions, view, waitFor, dispatchFor, approve, patch, approveInFull, patchAtExecute, completeStep, failStep, driveToGate, approveCommand }
}
