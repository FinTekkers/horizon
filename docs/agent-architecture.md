# Agent architecture — which process runs a step, and how its provider is chosen

`docs/workflow.md`'s "Which agent does what" table names the *label* a step
shows (PM, Architect, Eng, ...). `docs/architecture.md`'s layer map shows the
farm as one box. Neither answers two questions that matter once something
goes wrong: which actual *process* executes a given step, and which AI
provider (Claude, Muse, ...) that process used for this particular run. This
doc answers both, and documents the gaps in between as current behavior, not
as things this doc fixes.

## Two execution paths: PM session vs. fresh agent

Every agent step is routed one of two ways, decided once, in
`farm/farmd.py:552`:

```python
queue = "pm" if body["step"].get("index", 99) in (0, 1, 2, 9) else "runs"
```

(comment at `farmd.py:544-546`). That single line is the whole routing rule.

| Step index | Label (`server/src/lifecycle.js:17-34`) | `agent` field | Executes as |
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
in its `STEP_CONFIG` dict (`step_agent.py:56-71`: 4, 6, 7, 8, 11, 12, 14) —
spawned in its own tmux session per dispatch, does exactly one step, reports
back, and exits. "PM session" means `farm/pm_agent.py`, a long-running loop
that resumes the same provider-side conversation across every PM-queued
step, for every item, for as long as the farm has been up — see
[Session persistence](#session-persistence--why-steps-0-1-2-9-arent-reproducible)
below. Gates (3, 5, 10, 13, 15) get no agent dispatch at all; a human must
act in the UI.

**Gotcha: step 2 is not what its label implies.** `server/src/lifecycle.js:20`
labels step 2 `Architect`, and the table above (and `docs/workflow.md`'s
table) show that label. But step 2 does **not** run a separate Architect
process. `farmd.py:552` routes it into the PM queue along with 0, 1 and 9,
and `pm_agent.py:23` loads exactly one role file, `farm/roles/pm.md`, for
every PM-queued task regardless of which of the four steps it is. The "Set
guardrails" instructions live inline in that same file, at
`farm/roles/pm.md:23-25`, alongside the outcome/metric/review-summary
instructions. There is no separate Architect *process* for step 2 — a real
ephemeral `Architect` process only exists for step 7 (role file
`architect_review.md`, `step_agent.py:59`), which is a different, unrelated
step that happens to share the same label.

## Session persistence — why steps 0, 1, 2, 9 aren't reproducible

The PM agent's docstring states the design directly (`pm_agent.py:3-7`): it
"executes exactly one lifecycle step per task via a resumed Claude session
(context accumulates across items for the life of the farm)". Three facts
follow from that, and from reading how the resume actually works:

1. **A `farmd` restart or a killed tmux pane does not lose the memory.** The
   session id is persisted to
   `STATE_DIR / f"pm-session-{project_slug}.txt"` — i.e.
   `~/.horizon-farm/state/pm-session-<project>.txt` (`pm_agent.py:59-60`).
   On every task, `process()` reads that file back if it exists
   (`pm_agent.py:113-114`) and passes it as `session_id=` into `run_agent()`
   (`pm_agent.py:119`), resuming the same provider-side conversation. If the
   reply carries a new session id, it's written back to the same file
   (`pm_agent.py:120-121`).
2. **The file is not provider-tagged.** `pm_agent.py:60` names it by project
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
   `run_agent()` call at `pm_agent.py:119` that checks whether the resume
   actually happened. This is inferred from the absence of such a branch, not
   from an observed failure; phrase any claim about it as "the code can't
   tell the difference," not as a tested behavior.

**Concierge parallel.** `farm/concierge_agent.py` has the identical shape:
`ConciergeState.session_path` is `STATE_DIR / f"concierge-session-{slug}.txt"`
(`concierge_agent.py:88`), read back via `session_id()` and written back via
`save_session()` on every message. Same project-only naming, same missing
provider tag, same silent-restart-on-mismatch behavior.

| | PM | Concierge |
| --- | --- | --- |
| Session file | `pm-session-<project>.txt` (`pm_agent.py:59-60`) | `concierge-session-<project>.txt` (`concierge_agent.py:88`) |
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
play, i.e. only for steps 4, 6 and 7 (`step_agent.py:633-636`,
`step_agent.py:645-648` — see [Provider selection](#provider-selection--resolution-order-and-propagation)
below). PM-queued steps never get that treatment: `pm_agent.py`'s
`run_agent()` call (`pm_agent.py:119`) takes no `provider=` argument and
nothing about the PM's run is recorded per-run anywhere. This is documented
as current behavior and a gotcha, not fixed here — provider-tagging the
session file is a separate piece of work.

## Provider selection — resolution order and propagation

`farm/agent_runner.py`'s `run_agent()` is the single seam every caller
(PM, concierge, step agent) goes through (`agent_runner.py:1-8`). Which
provider module it dispatches to is resolved in this order:

1. **An explicit `provider=` argument to this one call**, if given
   (`agent_runner.py:47-69`'s docstring). Only ever set by a persona-forced
   provider override — see below. It cannot leak into a later call in the
   same process, since it's a plain function parameter, not an env var.
2. **`os.environ.get("FARM_PROVIDER", FARM_PROVIDER)`, read at call time, not
   at import time** (`agent_runner.py:22-25`) — so a process that's been
   running for a while still picks up an env change on its *next* call.
3. **The `config.py:37` default, `"claude"`.**

**Persona override.** `farm/personas.py:45`'s `PERSONA_PROVIDERS` maps only
`muse_smoke_test` → `"muse"` today. Every real persona — `fullstack`,
`python_backend`, `frontend_ui` — is absent from that map, so
`provider_for()` (`personas.py:61-68`) returns `None` for them, and their
steps fall through to (2)/(3) above unchanged. The override is only ever
*honored*, even when a persona does map to one, on steps 4, 6 and 7:
`PROVIDER_OVERRIDE_ELIGIBLE_STEPS = {4, 6, 7}` (`step_agent.py:78`), applied
at `step_agent.py:446`. Implement (11) and deploy (14) can never receive a
provider override, enforced in code — not just by naming convention on the
persona. PM-queued steps (0, 1, 2, 9) never pass a `provider=` argument at
all (`pm_agent.py:119` has no such parameter), so they are always
`FARM_PROVIDER`/default-routed, never persona-routed.

**Gotcha: the staleness trap.** Reading step 1 and 2 together answers the
ticket's question — "what has to happen for a `FARM_PROVIDER` change to take
effect everywhere" — and the answer is not "just set the env var." tmux
sessions inherit the tmux *server's* environment, not the shell that started
farmd, so every `FARM_*` variable is baked into the launch command at session
*creation time* by `tmux_mgr._farm_env_prefix()` (`tmux_mgr.py:23-26`).
Ephemeral steps get a brand-new tmux session per dispatch
(`farmd.py:322-327`), so they pick up a `FARM_PROVIDER` change on the very
next step. The PM session is different: it's launched once, at farm start
(`_start_async` → `_launch_pm_session`, `farmd.py:419`, itself defined at
`farmd.py:352-360`), and is only ever relaunched by the watchdog if its tmux
session is found dead (`farmd.py:392-397`), or by a same-project
`POST /farm/start` recovering an already-dead session (`farmd.py:456-458`).
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

## Muse provider

For the Muse CLI's actual interface — flags, event stream, session
continuity, what's verified vs. unverified — see
[`docs/providers/muse-code.md`](providers/muse-code.md); it is not restated
here.

**Gotcha: the PATH / `FARM_MUSE_BIN` gap.** The farm's tmux `PATH` does not
include `~/.local/bin`, and `_farm_env_prefix()` only ever forwards
`FARM_*`, `WA_*`, `CLAUDE_*` and `HORIZON_URL` into a launched session — never
`PATH` (`tmux_mgr.py:23-26`). `FARM_MUSE_BIN` defaults to the bare name
`"muse"` (`config.py:43`), resolved against whatever `PATH` the tmux session
actually has. That means the `/usr/local/bin/muse` symlink
(`docs/providers/muse-code.md`'s "the symlink is load-bearing" section) is
not an installation detail — it is load-bearing for every farm-launched agent
to find the binary at all. This is current behavior, not intended design;
removing the symlink without replacing the PATH/`FARM_MUSE_BIN` setup breaks
every Muse-routed step with no farm-side warning.
