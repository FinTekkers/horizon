# Making the PM agent's steps ephemeral — recommendation

**HZ-115.** Generated 2026-10-01. This document **identifies and designs**; it
implements no part of the migration. `farm/pm_agent.py` and
`farm/step_agent.py` are unchanged by the ticket that produced it.

Steps **0** (Define the outcome), **1** (Define how we measure success),
**2** (Set guardrails) and **9** (Summarize reviews & recommend) run inside one
long-lived PM agent session. Every other agent step is ephemeral. This is the
recommendation for closing that gap.

> **Every number below was printed by a command in
> [Reproducing the numbers](#reproducing-the-numbers).** None is estimated.

---

## 1. Recommendation

**Ship Option B — keep `farm/pm_agent.py`, spawn it once per task — with
Option D's explicit-context block folded in as a prerequisite stage, and
Option C used as an intermediate measurement stage rather than an endpoint.**

The three facts that decide it:

1. **The accumulated context is load-bearing.** Measured, not assumed — §2.
   So no option that simply deletes the session is acceptable.
2. **Going ephemeral costs a median of 0.326 s per step** against a median
   step time of 13 s, and the PM lane *already* pays a measured median 2 s
   queue poll. The migration is cheaper than the overhead it already carries — §3.
3. **B closes three of the four audit gaps for free and the fourth with ~6
   lines; A closes the same four but at several times the surface area; C
   closes one; D closes none.** — §4, §5.

### Rejected alternatives

| Option | Verdict | Why |
| --- | --- | --- |
| **A.** Fold 0/1/2/9 into `step_agent.py` | **Rejected for now** — revisit as a later consolidation | Right in the long run, wrong as the first move. §5.1 |
| **B.** Per-task `pm_agent.py` | **Recommended** | Smallest change that closes all four gaps. §5.2 |
| **C.** Long-lived loop, drop session resume | **Rejected as an endpoint; adopted as Stage 2** | Buys reproducibility only. Stale code, stale env and shared blast radius all remain. §5.3 |
| **D.** Don't migrate; inject context explicitly | **Rejected as an endpoint; mandatory as Stage 1** | Fixes **zero** of the four audit gaps — every one is a property of the process, not the prompt. §5.4 |

---

## 2. The evidence that settled the accumulated-context question

The ticket's guardrail is explicit: *"Do not assume the accumulated context is
worthless. It is the one genuine argument for the current design."*

### The method

`build_prompt()` (`farm/pm_agent.py`) renders only the **current** item's
`desc`/`metric`/`guardrails`, its own prior artifacts, its own feedback, and
the project rules. It never serialises another item's fields. Therefore a
verbatim 8-word phrase appearing in two *different* items' `patch` output
cannot have arrived through the prompt. The resumed session is the only
remaining channel.

The instrument is `farm/tools/analyze_pm_context_reliance.py`; its output is
committed at [`docs/pm-context-reliance-analysis.md`](pm-context-reliance-analysis.md).

### The result

Against the production log — **341 PM runs across 85 distinct work items**:

**49 shared-phrase occurrences survive every exclusion.** For example
HZ-79 (run 546) → HZ-95 (run 642): *"blocked is visually distinct from idle
paused and queued"*.

The exclusions matter more than the headline, because the method has to argue
against itself before it concludes. Four classes of false positive are
removed, each with its reason printed in the report:

| Excluded | Count | Why it is not evidence |
| --- | --- | --- |
| Role-prompt / rules text | — | `farm/roles/pm.md` is appended to every call, and `render_rules_section()` renders `farm/rules/` into every prompt. Shared wording here is explained by the prompt. |
| File-path-shaped text | 5 | Two items listing the same repo files produce identical word sequences from the directory layout, not from recall. |
| Convergent boilerplate | 29 | A shingle written independently by 3+ distinct items is a stock phrase, not recall of one earlier item. |
| Same-item reuse | — | An item's own revision echoing its own earlier patch is self-consistency. |

**Corpus coverage is reported as a number, not implied: 156/341 runs yielded a
parseable `patch` field.** The other 185 proposed no patch (legitimate and
common — the step often reports "no changes needed"), failed, or never echoed
reply text to the log at all.

### Verdict, and its limits

**Load-bearing: yes, evidenced.** The model carries specific prior wording
across items through session memory.

Two limits stated rather than glossed:

- **This is a one-directional proof.** Finding reuse proves the channel is
  live. It does **not** measure how much the output would *degrade* without
  it. That is what Stage 2 (§6) exists to establish, before anything is
  deleted.
- **The corpus is Claude-only.** Only `farm/providers/claude.py` echoes reply
  text and timing into the log; `farm/providers/muse.py` prints neither. A
  Muse-routed PM run is invisible to both instruments. Both now report this
  in their own output.

**Consequence for the migration: the context may not simply be dropped.** It
must be replaced with an explicit, reproducible prompt input. That is why
Option D is a mandatory stage rather than a competing option.

---

## 3. Measured cost of going ephemeral

The ticket requires this be quantified, "not hand-waved." Source:
`farm/tools/pm_run_timings.py` against the production log.

**Corpus coverage: 338/341 runs carry a timing line (3 unmeasured, Claude-only
corpus — see §2).** Model time is logged to whole seconds, so a short step
carries roughly ±10% quantisation.

### Model time per step — the denominator

| Step label | n | min | median | p90 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Define the outcome | 94 | 2 s | **9 s** | 24 s | 44 s |
| Define how we measure success | 79 | 1 s | **6 s** | 21 s | 50 s |
| Set guardrails | 80 | 2 s | **9 s** | 23 s | 51 s |
| Summarize reviews & recommend | 85 | 12 s | **25 s** | 39 s | 227 s |

Pooled: median **13 s**, p90 30 s, max 227 s (n=338). This broadly confirms the
ticket's "roughly 10-20 seconds each" for steps 0-2, and shows step 9 is
substantially more expensive.

### Overhead the PM lane already pays

`pm_agent.main()` polls its queue on `time.sleep(2)`. Measured as the gap from
one run's `reported` line to the next run's header, split at 5 s so genuine
idle waiting cannot inflate the figure:

- **Poll latency (≤5 s): n=184, median 2 s, p90 2 s, max 4 s.**
- Idle waits (>5 s): n=156, median 560.5 s — not per-step cost, listed so the
  split is auditable.

**The current design is not overhead-free.** It already pays a median 2 s per
step before the model is called.

### Spawn overhead — the number every prior analysis left open

Measured on the farm host over 5 samples:

| Component | min | median | p90 | max |
| --- | ---: | ---: | ---: | ---: |
| Cold CPython + `import farm.pm_agent` | 0.272 s | **0.294 s** | 0.428 s | 0.428 s |
| tmux new / has / kill round trip | 0.028 s | **0.029 s** | 0.048 s | 0.048 s |
| **Total added per step** | **0.301 s** | **0.326 s** | **0.456 s** | **0.456 s** |

### The verdict against the pre-published threshold

The acceptance threshold **≤ 2 s** was published in the approved options
artifact *before* this measurement was taken, so the decision cannot be fitted
to the number.

**Measured median 0.326 s — comfortably inside the threshold, and about a
sixth of the 2 s queue poll the PM lane already pays today.**

Queue-poll latency itself is a wash: the ephemeral dispatcher polls on
`time.sleep(3)` (0-3 s, mean 1.5 s) against the PM's measured median 2 s.

**Net: ephemeral execution adds roughly 0.33 s to a 13 s median step — under
3%, and under 1.5% of step 9's 25 s median.** The cost argument does not
defend the long-lived design.

---

## 4. The four audit gaps

| Gap | Status under Option B | Mechanism |
| --- | --- | --- |
| **Per-run log** | **Closed, free** | `_run_session_name()` already yields `farm-run-hz-115-s0-a1`; `_claim_and_launch()` passes `log_file=LOGS_DIR/<name>.log` to `tmux_mgr.new_session`. No new code. |
| **Env freshness** | **Closed, free** | A new tmux session per run; `tmux_mgr._farm_env_prefix()` stamps the current `FARM_*` / `HORIZON_URL` values at creation. A deploy's config changes reach the very next step. |
| **Code freshness** | **Closed, free** | A fresh interpreter imports current modules every run. The "deploy ships a fix and the running agent keeps executing the old module" failure disappears. |
| **Provider / `command_id` provenance** | **NOT free — needs ~6 lines** | See below. |

### Provenance does not come for free with ephemerality

This is the gap most easily assumed away. `farm/step_agent.py` stamps
`provider` / `command_id` **only when a persona forced an override**:

```python
if provider_override:
    note = f"provider={reply_provenance.get('provider')} command_id={reply_provenance.get('command_id')}"
```

Default-routed steps record nothing. So a PM step made ephemeral would *still*
have no provenance stamp — the tmux log and the `farm-run-*` name would be
new, but the `provider=… command_id=…` line would not.

**Fix in the same PR:** stamp unconditionally in `pm_agent.process()`, from the
`provider` and `command_id` keys `run_agent()` already returns
(`farm/agent_runner.py` sets `result["provider"]` and
`result.setdefault("command_id", None)` on every call). The data is already
there; only the `if` is in the way.

### Still open after this item — named, not passed over

- **Unconditional provenance for `step_agent.py`'s own default-routed steps.**
  Out of scope here — this item touches the PM path only. **Deserves its own
  ticket.**
- **No provider sets `SUPPORTS_RESUME = False`** (`claude.py` and `muse.py`
  both set `True`), so the resume-refusal guard in `farm/agent_runner.py` is
  dead code today. Muse session ids are caller-supplied, so a Claude id handed
  to Muse is accepted as a brand-new session: **still a silent context reset,
  still no error.** Option B makes this moot for the PM path (no session file
  survives Stage 4) but does not fix the guard.
- **The session id is not provider-tagged.** `session_file()` names it by
  project only. Resolved for the PM path by Stage 4; the concierge's own
  untagged `concierge-session-<slug>.txt` is **out of scope by explicit
  decision**.

---

## 5. Options evaluated

### 5.1 Option A — fold 0/1/2/9 into `step_agent.py`

**Rejected for now.** Consolidation is real value, but it lands the riskiest
refactor and the lane flip in one change, on the four steps every downstream
step depends on.

Cost, measured against the current files:

- `step_agent.py` is **840 lines** and carries **7 worktree references**;
  `pm_agent.py` has **0**. PM steps need no tree, so a workspace-skip path
  must be added around `ensure_item_worktree()`, which today fires for any
  item with a `repo`.
- `_assert_step_config_matches_table()` raises at **import time** unless
  `STEP_CONFIG`'s labels exactly equal the table's `runsIn == "farm"` labels.
  Flipping a step to the farm lane without adding it to `STEP_CONFIG` crashes
  **every** ephemeral agent at import. That is a good failure, but it makes
  the lane flip and the config edit inseparable.
- PM steps carry **no budgets**: `maxTurns` and `timeoutS` are `null` for all
  four `runsIn: "pm"` entries. Option A must invent real values for four steps
  that have never had them. Option B keeps `farm/config.py`'s `MAX_TURNS = 8`
  / `STEP_TIMEOUT_S = 900` defaults.
- `PATCH_FIELDS` and `_mark_truncated()` (HZ-114's truncation marking) must
  move into a file with no patch concept at all — along with the
  `domain.py.fields` import they depend on.
- `PM_MODEL` (`FARM_PM_MODEL`) must be threaded per step; `step_agent` never
  passes `model=`.
- `farm/tests/test_pm_agent.py` is rewritten, not kept.

The ticket's own guardrail warns against pre-committing to this file. The
measurement above does not overturn that.

### 5.2 Option B — per-task `pm_agent.py` *(recommended)*

Same module, one task, then exit. Its own tmux session and its own log.

**Pros**

- Smallest change that closes **all four** audit gaps.
- `PATCH_FIELDS`, `_mark_truncated()` and `validate()` do not move — HZ-114's
  truncation marking is untouched.
- **No workspace machinery to skip** — `pm_agent.py` has zero worktree
  references. The problem Option A must solve does not exist here.
- `notify_started()` already performs the `/started` handshake, identically to
  the ephemeral dispatcher's `_notify_started()`. Leaving the call exactly
  where it is preserves HZ-57's queue-watchdog-to-execution-timer handoff and
  the PR #84 bug class.
- No step-table budget changes — `config.py` defaults still apply.
- `farm/tests/test_pm_agent.py` keeps passing.
- `patch` already flows generically: `/internal/steps/result` forwards
  `body.get("patch")` with nothing PM-specific about it.

**Cons**

- Two step-runner modules remain; the duplicated prompt/report plumbing
  persists until the Stage 5 consolidation.
- PM steps begin consuming `MAX_EPHEMERAL` slots (default **4**) shared with
  implement steps. At a 13 s median this is minor, but it is a real change to
  contention and should be watched after the flip — consider raising
  `FARM_MAX_EPHEMERAL` if intake latency regresses.
- `runsIn: "pm"` becomes a slightly misleading name: it selects a *module*,
  not a *long-lived session*. **Recommended: do not rename it** — change its
  documented meaning instead. A rename would touch the step table, both
  language bindings, `STEP_CONFIG` and several tests: a rename tax on a change
  that should stay small.

**Effort: small.** `_claim_and_launch` picks the module; `pm_agent.main()`
gains `--task`; three PM-specific branches in `farmd` are deleted.

### 5.3 Option C — keep the long-lived loop, drop session resume

**Rejected as an endpoint; adopted as Stage 2.** Stop passing `session_id=`
and reproducibility arrives immediately for one line of change. But it fixes
**one gap of four**: stale code, stale env, shared blast radius, per-run log
and provenance all remain. As a *measurement* stage it is valuable, because it
isolates "does losing memory hurt the output" from "does per-process spawn
break things."

### 5.4 Option D — don't migrate; inject context explicitly

**Rejected as an endpoint; mandatory as Stage 1.** §2 shows the context is
real, so it must be replaced explicitly. But injecting context changes nothing
about per-run logs, provenance, env freshness or code freshness — **it fixes
zero of the four audit gaps**, because every one is a property of the process,
not the prompt. Worse, explicit context *plus* an invisible resumed session is
harder to reason about than either alone — which is why D ships before the
resume is dropped, not instead of it.

---

## 6. Migration path

Five stages, each independently revertible. **Stage 2 is the evidence gate —
do not skip it.**

**Stage 1 — inject explicit context, still long-lived.** Add a named, capped
`Project context` block to `build_prompt()`, fed by the server at `/steps/run`
alongside `rules`. Content: recent items' id, title and one-line outcome, plus
prior feedback on rejected phrasing. Cap it with HZ-114-style marking, never a
silent slice. Purely additive — the session still resumes.

**Stage 2 — drop the resume, measure the delta.** Stop passing `session_id=`.
Run 10 real intake steps. Re-run `analyze_pm_context_reliance` and confirm
cross-item phrase reuse drops toward zero. **Compare output quality by hand,
against a pre-registered rule: if the no-resume arm is materially worse in
≥ half the pairs, Stage 1's block is too thin — fix it here, before the lane
flip.** This is the only stage that measures what the context is *worth*,
as opposed to proving the channel exists.

**Stage 3 — flip the lane.** Route the `pm` lane through the ephemeral queue.

- In `_claim_and_launch()`, select the module from the step entry instead of
  hardcoding `farm.step_agent`:
  ```python
  module = "farm.pm_agent" if runner == "pm" else "farm.step_agent"
  ```
- `pm_agent.main()` takes `--task <path>` instead of `--project`: process one
  task, report, unlink, exit — the same shape as `step_agent.main()`. It
  already has `--once`, so this is a smaller change than it sounds.
- **Keep `notify_started()` exactly where it is** (see §7).
- Stamp provenance unconditionally in `process()` (§4).
- Then delete `_launch_pm_session()`, the watchdog's PM revive branch,
  `PM_ACTIVE_RUNS` with its `_run_alive` branch, and the `pm` queue arm of
  `_run_state`.

**Stage 4 — delete the session file.** Remove `session_file()` and clean up
`~/.horizon-farm/state/pm-session-*.txt`. **Only after Stage 2 passed.**

**Stage 5 — consolidate (separate ticket).** Extract the shared
`build_prompt` / report / artifact-cap plumbing from both modules. **Not part
of this migration** — this is where Option A's real value is banked, once
ephemeral intake has proven stable.

### Where each concern lives afterwards

| Concern | Owner after migration |
| --- | --- |
| Steps 0/1/2/9 | `farm/pm_agent.py`, one process per step |
| `PATCH_FIELDS` field revision | `farm/pm_agent.py` — **unmoved** (its limits are derived from the shared `domain/fields.json` via `fields.patch_limits()`, so the migration inherits them unchanged) |
| Workspace machinery | **Not skipped — never present.** `pm_agent.py` has zero worktree references |
| Lane routing | `domain/steps.json`'s `runsIn` → `domain/py/steps.py` (`steps.STEPS`) → `lane_for_index()` |
| Module selection | `_claim_and_launch()` in `farm/farmd.py` — **the one real code change** |
| `/started` handshake | `notify_started()` in `farm/pm_agent.py` — **unmoved** |

### A correction to the ticket's own plan

The ticket describes the routing change as *"one line in `farm/farmd.py:552`"*.
**That line no longer exists.** HZ-117 replaced the hardcoded `(0, 1, 2, 9)`
tuple with `lane_for_index()`, which reads the `runsIn` field from
`steps.STEPS`. That table is **not** Python source: it is the shared
`domain/steps.json`, read live by both language bindings (`domain/py/steps.py`
and `domain/js/lifecycle.js`). **The lane is data, edited in JSON — not a
line of Python.**

The equivalent change is therefore a `runsIn` edit in `domain/steps.json`
plus a two-line module switch in `_claim_and_launch()`. Because the table is
shared, that edit is simultaneously visible to the server and the UI, and is
covered by the existing three-way parity tests — so it cannot drift between
languages the way a hardcoded tuple could.

---

## 7. Guardrails honoured

- **Nothing was implemented.** No edit to `farm/pm_agent.py` or
  `farm/step_agent.py` under this ticket. Verify mechanically:
  ```
  git diff --stat origin/main... -- farm/pm_agent.py farm/step_agent.py \
    farm/concierge_agent.py infra/whatsapp-bridge/
  ```
  This must print nothing.
- **The concierge agent and the whatsapp-bridge are untouched.** They remain
  long-lived and on Claude **by explicit decision, not oversight**. Nothing in
  this recommendation reaches `farm/concierge_agent.py` or the bridge, and the
  concierge's own untagged session file is named in §4 as out of scope rather
  than passed over.
- **The accumulated context was not assumed worthless.** It was measured
  across 341 runs and found load-bearing, which is why Option D's content is
  mandatory rather than optional.
- **`step_agent.py` was not pre-committed to.** It was evaluated as Option A
  and rejected on measured cost (§5.1).
- **The `/started` handshake and the HZ-57 handoff are preserved.**
  `notify_started()` stays exactly where it is, called after the task is
  claimed and before `process()`. Under Option B, `farmd`'s
  `_claim_and_launch()` also calls `_notify_started()` before launching — the
  follow-up must ensure the run is notified **once**, not twice, and must keep
  the "inactive ⇒ do not launch" branch intact. This is the single highest-risk
  detail in the migration and is called out as such.
- **What the PM steps produce, and how the orchestrator sequences them, is
  unchanged.** Only where and how they execute changes.

---

## Reproducing the numbers

Both tools read a host-local log, so CI cannot reproduce these figures; the
tests run on fixtures instead. This document is stamped with its generation
date, following `docs/text-caps-measurement.md`.

```bash
# §3 — per-step cost, queue-poll latency, and spawn overhead
python -m farm.tools.pm_run_timings \
  --log ~/.horizon-farm/logs/pm-horizon.log --spawn-bench 5

# §2 — the context-reliance evidence
python -m farm.tools.analyze_pm_context_reliance \
  --log ~/.horizon-farm/logs/pm-horizon.log --as-of 2026-10-01
```

The spawn benchmark deliberately names its throwaway tmux sessions
`hz115-spawnbench-*`, **not** `farm-*`: `tmux_mgr.list_farm_sessions()` counts
every `farm-`-prefixed session against `MAX_EPHEMERAL`, so a benchmark using
that prefix would eat a real dispatch slot on a live host.
