# Agent architecture — which process runs a step, and how its provider is chosen

`docs/workflow.md`'s "Which agent does what" table names the *label* a step
shows (PM, Architect, Eng, ...). `docs/architecture.md`'s layer map shows the
farm as one box. Neither answers two questions that matter once something
goes wrong: which actual *process* executes a given step, and which AI
provider (Claude, Muse, ...) that process used for this particular run. This
doc answers both, and documents the gaps in between as current behavior, not
as things this doc fixes.

## Two execution paths: PM session vs. fresh agent

Every agent step is routed one of two ways, decided once, by
`lane_for_index()` in `farm/farmd.py`:

```python
def lane_for_index(step_table: list[dict], index, default: str = "runs") -> str:
    entry = next((e for e in step_table if e["index"] == index), None)
    if entry is None:
        return default
    return "pm" if entry["runsIn"] == "pm" else default
```

**The lane is data, not a hardcoded tuple of indices.** HZ-117 replaced the
earlier `index in (0, 1, 2, 9)` check with this lookup against the step
table's `runsIn` field, so an inserted or reordered step carries its own lane
with it. The field is authored in `domain/steps.json` and loaded as
`steps.STEPS`. An index absent from the table (a gate, which is never
dispatched here at all) falls back to `default`.

| Step index | Label (`domain/steps.json`) | `agent` field | Executes as |
| --- | --- | --- | --- |
| 0 | Define the outcome | PM | PM session |
| 1 | Define how we measure success | PM | PM session |
| 2 | Set guardrails | Architect | PM session |
| 3 | Approve & prioritize this work | — | gate, no agent |
| 4 | Plan options & trade-offs (pros / cons) | Ensemble | fresh ephemeral agent |
| 5 | Approve the high-level design | — | gate, no agent |
| 6 | Draft implementation plan | Eng | fresh ephemeral agent |
| 7 | Architecture review | Architect | fresh ephemeral agent |
| 8 | QA reviews the test plan | QA | fresh ephemeral agent |
| 9 | Summarize reviews & recommend | PM | PM session |
| 10 | Review before execution | — | gate, no agent |
| 11 | Specialist agent implements | Eng | fresh ephemeral agent |
| 12 | Automated review (code + QA) | Review | fresh ephemeral agent |
| 13 | Accept the code | — | gate, no agent |
| 14 | Deploy the changes | DevOps | fresh ephemeral agent |
| 15 | Review the work & close | — | gate, no agent |

"Fresh ephemeral agent" means `farm/step_agent.py`, one of the step indices
in its `STEP_CONFIG` dict (4, 6, 7, 8, 11, 12, 14) —
spawned in its own tmux session per dispatch, does exactly one step, reports
back, and exits. "PM session" means `farm/pm_agent.py`, a long-running loop
that resumes the same provider-side conversation across every PM-queued
step, for every item, for as long as the farm has been up — see
[Session persistence](#session-persistence--why-steps-0-1-2-9-arent-reproducible)
below. Gates (3, 5, 10, 13, 15) get no agent dispatch at all; a human must
act in the UI.

**Gotcha: step 2 is not what its label implies.** `domain/steps.json`
labels step 2 `Architect`, and the table above (and `docs/workflow.md`'s
table) show that label. But step 2 does **not** run a separate Architect
process. Its `runsIn: "pm"` entry routes it into the PM queue along with 0,
1 and 9, and `pm_agent.py`'s module-level `ROLE_PROMPT` loads exactly one
role file, `farm/roles/pm.md`, for every PM-queued task regardless of which
of the four steps it is. The "Set guardrails" instructions live inline in
that same file, alongside the outcome/metric/review-summary instructions.
There is no separate Architect *process* for step 2 — a real ephemeral
`Architect` process only exists for step 7 (role file
`architect_review.md`), which is a different, unrelated step that happens to
share the same label.

## Session persistence — why steps 0, 1, 2, 9 aren't reproducible

The PM agent's docstring states the design directly (`pm_agent.py`'s module docstring): it
"executes exactly one lifecycle step per task via a resumed Claude session
(context accumulates across items for the life of the farm)". Three facts
follow from that, and from reading how the resume actually works:

1. **A `farmd` restart or a killed tmux pane does not lose the memory.** The
   session id is persisted to
   `STATE_DIR / f"pm-session-{project_slug}.txt"` — i.e.
   `~/.horizon-farm/state/pm-session-<project>.txt` (`session_file()`).
   On every task, `process()` reads that file back if it exists
   (`process()`) and passes it as `session_id=` into `run_agent()`,
   resuming the same provider-side conversation. If the reply carries a new
   session id, it's written back to the same file (same `process()` branch).
2. **The file is not provider-tagged.** `session_file()` names it by project
   slug only, with no provider in the name or contents. Switching
   `FARM_PROVIDER` hands whatever id is on disk to a different provider's
   `run_agent()` call. That provider doesn't recognize the id as its own,
   silently starts a fresh conversation, and overwrites the file with its own
   session id — there is no error, no warning, and no record that the switch
   happened. This is not hypothetical: the file was observed being rewritten
   at 19:54 during a live `FARM_PROVIDER` switch to Muse.
3. **A provider-side session expiry degrades to fresh context with no error
   and no log line.** Nothing in `process()` distinguishes an expired session
   from a fresh one — there is no error-handling branch around the
   `run_agent()` call in `process()` that checks whether the resume
   actually happened. This is inferred from the absence of such a branch, not
   from an observed failure; phrase any claim about it as "the code can't
   tell the difference," not as a tested behavior.

**Concierge parallel.** `farm/concierge_agent.py` has the identical shape:
`ConciergeState.session_path` is `STATE_DIR / f"concierge-session-{slug}.txt"`
(`ConciergeState`), read back via `session_id()` and written back via
`save_session()` on every message. Same project-only naming, same missing
provider tag, same silent-restart-on-mismatch behavior.

| | PM | Concierge |
| --- | --- | --- |
| Session file | `pm-session-<project>.txt` (`session_file()`) | `concierge-session-<project>.txt` (`ConciergeState`) |
| Keyed by | project slug only | project slug only |
| Provider-tagged? | No | No |
| Survives a process restart? | Yes | Yes |

**Net effect.** Identical input to the PM agent can get different treatment
— fresh context vs. accumulated context from every prior item — depending
on how long the farm has been up and which provider last wrote that session
file. This happens on steps 0, 1, 2 and 9: the steps that define an item's
outcome, success metric and guardrails, and that later summarize every
review for the human at the "Review before execution" gate — everything
downstream depends on their output. They are also the least auditable steps
in the pipeline. `step_agent.py` stamps `provider`/`command_id` into the run
log and artifact, but only when a persona-forced provider override is in
play, i.e. only for steps 4, 6 and 7 (the `if provider_override:` branches
at the end of `execute()` — see [Provider selection](#provider-selection--resolution-order-and-propagation)
below). PM-queued steps never get that treatment: `pm_agent.py`'s
`run_agent()` call in `process()` takes no `provider=` argument and
nothing about the PM's run is recorded per-run anywhere. This is documented
as current behavior and a gotcha, not fixed here — provider-tagging the
session file is a separate piece of work.

## Provider selection — resolution order and propagation

`farm/agent_runner.py`'s `run_agent()` is the single seam every caller
(PM, concierge, step agent) goes through (`agent_runner.py`'s module docstring). Which
provider module it dispatches to is resolved in this order:

1. **An explicit `provider=` argument to this one call**, if given
   (`run_agent()`'s docstring). Only ever set by a persona-forced
   provider override — see below. It cannot leak into a later call in the
   same process, since it's a plain function parameter, not an env var.
2. **`os.environ.get("FARM_PROVIDER", FARM_PROVIDER)`, read at call time, not
   at import time** (`agent_runner.py`'s module-level provider resolution) — so a process that's been
   running for a while still picks up an env change on its *next* call.
3. **The `farm/config.py` default, `"claude"`.**

**Persona override.** `farm/personas.py`'s `PERSONA_PROVIDERS` ships
**empty** (HZ-121) — no shipped persona forces a non-default provider yet.
The mechanism is proven by a test-registered fixture persona
(`farm/tests/conftest.py`'s `muse_smoke_test_persona`), not a shipped one.
Every real persona is absent from that map, so `provider_for()` returns
`None` for them, and their steps fall through to (2)/(3) above unchanged.
Since HZ-125 the map is keyed by the *namespaced* persona id
(`"<agent>.<persona>"`, e.g. `eng.python`) because ids are only unique within
an agent, and `provider_for()` takes the item's whole `{agent: persona}` map
rather than one id — a provider-forcing persona in any slot wins, since the
only one that exists is a test fixture and the override-eligible steps compose
no persona at all. The override is only ever
*honored*, even when a persona does map to one, on steps 4, 6 and 7 — the
steps whose `domain/steps.json` entry carries `providerOverrideEligible:
true`, read via `domain/py/steps.py`'s `provider_override_eligible()`
(HZ-117 replaced the old `PROVIDER_OVERRIDE_ELIGIBLE_STEPS` allowlist;
HZ-128 relocated the table) and applied in `step_agent.py`'s `execute()`.
Implement (11) and deploy (14) can never receive a provider override,
enforced in code — not just by naming convention on the persona. PM-queued steps (0, 1, 2, 9) never pass a `provider=` argument at
all (`process()` has no such parameter), so they are always
`FARM_PROVIDER`/default-routed, never persona-routed.

**Gotcha: the staleness trap.** Reading step 1 and 2 together answers the
ticket's question — "what has to happen for a `FARM_PROVIDER` change to take
effect everywhere" — and the answer is not "just set the env var." tmux
sessions inherit the tmux *server's* environment, not the shell that started
farmd, so every `FARM_*` variable is baked into the launch command at session
*creation time* by `tmux_mgr._farm_env_prefix()`.
Ephemeral steps get a brand-new tmux session per dispatch
(`_claim_and_launch()`), so they pick up a `FARM_PROVIDER` change on the very
next step. **Since HZ-212 PM steps do too** — the rest of this paragraph
describes the long-lived PM session that HZ-212 retired, kept as history. The
PM session was different: it's launched once, at farm start
(`_start_async` → `_launch_pm_session`), and is only ever relaunched by the
watchdog if its tmux session is found dead, or by a same-project
`POST /farm/start` recovering an already-dead session.
Nothing kills a *live* PM session on an env change alone. So after flipping
`FARM_PROVIDER`, new ephemeral steps switch immediately; the PM session keeps
running against the old provider's env until its tmux session is actually
killed and relaunched — and per the previous section, that relaunch hands the
old provider's session id to the new provider, which silently starts fresh.
This is consistent with a farm reporting some steps on Claude and some on
Muse after a single `FARM_PROVIDER` change — the concrete mechanism, not just
a plausible story, though confirming it was the exact cause of any one
incident needs that incident's own timeline. It is current behavior and a
gotcha; it is not fixed here.

**Where this is being fixed.** The staleness trap, the missing per-run log
and the missing provenance stamp are all consequences of the PM session being
long-lived. HZ-115 measured the cost of ending that and recommends a path:
see [`docs/pm-step-ephemeral-recommendation.md`](pm-step-ephemeral-recommendation.md).
The concierge's own long-lived session is deliberately **not** in that scope.
HZ-204 shipped stage 1 (the context block); HZ-212 shipped stage 2: PM steps
run per task through `_claim_and_launch()`, with no session resume, each with
its own log.

## Muse provider

For the Muse CLI's actual interface — flags, event stream, session
continuity, what's verified vs. unverified — see
[`docs/providers/muse-code.md`](providers/muse-code.md); it is not restated
here.

**Gotcha: the PATH / `FARM_MUSE_BIN` gap.** The farm's tmux `PATH` does not
include `~/.local/bin`, and `_farm_env_prefix()` only ever forwards
`FARM_*`, `WA_*`, `CLAUDE_*` and `HORIZON_URL` into a launched session — never
`PATH` (`tmux_mgr._farm_env_prefix()`). `FARM_MUSE_BIN` defaults to the bare
name `"muse"` (`farm/config.py`), resolved against whatever `PATH` the tmux session
actually has. That means the `/usr/local/bin/muse` symlink
(`docs/providers/muse-code.md`'s "the symlink is load-bearing" section) is
not an installation detail — it is load-bearing for every farm-launched agent
to find the binary at all. This is current behavior, not intended design;
removing the symlink without replacing the PATH/`FARM_MUSE_BIN` setup breaks
every Muse-routed step with no farm-side warning.
