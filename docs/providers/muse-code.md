# Meta Muse Code — verified interface notes for HZ-81

Everything below was **run on the Horizon host** against Muse Code
`1.3.0 (1.3.0-R3401.1)` and observed, not taken from documentation. Where a
claim is unverified it says so explicitly.

This exists because HZ-81's options artifact recorded a blocking finding —
*"Meta Muse Code's real interface could not be verified… treat Muse as out of
scope until someone confirms its actual CLI/API"*. This is that confirmation.

## Install and location

```
curl -fsSL https://dev.meta.ai/install.sh | bash
```

Inspected before running. The installer uses **no `sudo`**, installs to
`$HOME/.local/bin`, fetches the launcher from `https://api.meta.ai/muse-launcher.sh`,
and **verifies a SHA256** against the response's `x-content-sha256` header,
aborting on mismatch. `dev.meta.ai` resolves to `star.c10r.facebook.com`.

On this host:

| Path | |
| --- | --- |
| `~/.local/bin/muse` | bash wrapper (symlink-safe: `resolve_self()` loops on `readlink`) |
| `~/.local/bin/muse-bin-1.3.0-R3401.1` | 281 MB binary |
| `/usr/local/bin/muse` | symlink → the wrapper |
| `~/.config/muse/auth.json` | credential written by `muse login` |

**The symlink is load-bearing.** The farm's PATH is
`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/snap/bin` — it does *not*
include `~/.local/bin`. And `tmux_mgr._farm_env_prefix()` only forwards
`FARM_*`, `WA_*`, `CLAUDE_*` and `HORIZON_URL` into agent sessions, never
`PATH`. Verified `muse` resolves both under the bare farm PATH and from a
fresh tmux session.

## What run_claude needs, and where it comes from

`run_claude()` returns `{"result": <final text>, "session_id": <id>}`.

```bash
muse exec --json '<prompt>'
```

emits **JSONL events on stdout**. The last event carries both halves:

```json
{"payload_type": "run.terminal.completed",
 "payload": {"terminal": "completed", "text": "horizon",
             "command_id": "e93cb8d2-f310-48f0-b698-539a49af55d5"}}
```

- `payload.text` → `result`
- `run.output.delta` events stream the same text incrementally, which
  preserves the live tmux-pane streaming the UI tails today
- observed event sequence: `runtime.command.accepted` → `session.run.linked`
  → `run.model.configured` → `turn.input.user` → `run.lifecycle.started` →
  `task.lifecycle.*` → `run.output.delta` → `run.terminal.completed`

Every event carries `sequence`, `payload_type`, `schema_version` and
`recorded_at`. `muse schema` exports the wire schema as JSON Schema or
TypeScript — prefer generating against that over hand-parsing.

## Session continuity — VERIFIED

`muse resume` is the *interactive* path (picker, or `--last`, or a session
UUID). It is **not** what the farm should use.

Headless continuity is `exec --session-id <UUID>`, and it genuinely carries
context. Verified with two separate processes sharing one id:

```
muse exec --json --session-id $SID 'Remember this number: 4721. Reply with just OK.'
  -> 'OK'
muse exec --json --session-id $SID 'What number did I ask you to remember?'
  -> '4721'
```

This is what `pm_agent.py` and `concierge_agent.py` need. Note the id is
**caller-supplied** — unlike Claude, where a session id is returned and then
echoed back. The farm can generate and own it.

Do not use `command_id` as the session handle: it identifies one run, and
`resume` expects a session UUID or name.

## Cost guardrail — the research was WRONG

There is **no `muse account status` command**. There is no `account`
subcommand at all. HZ-81's plan intended to build the subscription check
around it; that command does not exist.

What exists:

| | |
| --- | --- |
| `muse login` | browser OAuth → subscription; writes `~/.config/muse/auth.json` |
| `muse auth set --api-key-stdin` | stores a **metered** provider API key (read from stdin, never argv) |
| `muse exec --api-key-stdin` | metered key for one run |

So the `assert_subscription_auth()` analogue is **not** "run a status
command". It is: *assert the credential came from `login`, and that no
API-key path is in play*. Structurally the same guarantee as the Anthropic
check, established differently.

**Unverified:** nothing observed reports the subscription tier, remaining
budget, or the concurrent-subagent limit. The claim that
`muse-code account status` prints those does not hold for this CLI. The
concurrent-subagent limit therefore cannot be read at runtime and cannot be
reconciled with `FARM_MAX_EPHEMERAL` (currently 4) without vendor docs or
empirical testing.

## Flags that matter for the farm

| Flag | Why it matters |
| --- | --- |
| `--json` | machine-readable JSONL; required |
| `--session-id <UUID>` | headless continuity (above) |
| `--output-schema <FILE>` | **shapes the final answer to a JSON schema** (meta provider only) |
| `--max-model-steps <N>` | the `max_turns` analogue |
| `--model <ID>` | per-invocation model selection |
| `--reasoning-effort` | `none…ultra`, default `high` |
| `--prompt-file <PATH>` | avoids argv length limits on long prompts |
| `--approval-mode untrusted\|on-request\|never` | default `on-request` — **interactive**; headless runs need `never` |
| `--user-input-auto-resolve` | auto-cancels prompts that would otherwise block a headless run |
| `--disable-sandbox`, `--sandbox-network` | sandbox is **ON** by default; network defaults to `proxy-only` |
| `--trust-workspace` / `--yolo` | workspace trust (see below) |
| `-w, --worktree off\|create\|existing` | Muse can manage its own git worktree |
| `--no-session-log` | suppress on-disk session event logs |

Two of these are worth more than a table row.

**`--output-schema` may remove a whole class of bug.** Horizon's agents are
asked in prose to emit a JSON envelope, and `extract_json()` repairs what
comes back — HZ-44 exists because that fails on unescaped quotes and control
characters, and it has bitten at least three items. A provider that can
*enforce* the response shape sidesteps it entirely for Muse-run steps.

**Approval and sandbox default to ON.** `--approval-mode` defaults to
`on-request`, which will block a headless agent waiting for a human. Any farm
integration must set `never` (plus `--user-input-auto-resolve`) or runs will
hang rather than fail. Decide deliberately how much sandboxing to disable —
the implement step needs filesystem writes in its worktree.

## Workspace trust

Observed on stderr during a run in a scratch directory:

```
muse: workspace root: /tmp/... (cwd default)
muse: Agent delegation: auto unavailable: workspace is untrusted.
```

Muse has a workspace trust model, and an untrusted workspace loses agent
delegation. The farm runs agents in `~/.horizon-farm/workspaces/...`, so this
must be resolved — via `--trust-workspace`, `--workspace <PATH>`, or
persistent trust — before the implement step depends on subagents.

## What is still unverified

- subscription tier / remaining budget / concurrent subagent limit
- how exhaustion is reported (the `--max-model-steps` analogue of
  `error_max_turns`); HZ-81's retry classification depends on telling
  exhaustion from a real error, and no exhausting run was observed
- behaviour when the subscription is expired or the credential is revoked
- whether `--output-schema` failures are recoverable or terminal
- non-zero exit codes and their meanings; only `exit=0` was observed

## HZ-102: proving the wiring, end to end

HZ-83 built this provider and the seam; nothing routed a real step to it
until HZ-102. What HZ-102 adds:

- **Routing.** A single test-only persona, `muse_smoke_test`
  (`farm/personas.py`), maps to the Muse provider via `PERSONA_PROVIDERS`.
  `farm/step_agent.py` only honors that mapping on the pure-planning steps
  ("Plan options & trade-offs", "Draft implementation plan", "Architecture
  review") — never implement or deploy, enforced in code via
  `PROVIDER_OVERRIDE_ELIGIBLE_STEPS`, not just by convention on the persona.
  Every real persona (`fullstack`, `python_backend`, `frontend_ui`) is absent
  from `PERSONA_PROVIDERS`, so Claude stays the default for all real work.
  The override reaches `run_agent()` as an explicit `provider=` argument, not
  an env var — it can't leak into a later call in the same process.
- **Provenance.** `_parse_events` now returns `command_id` alongside
  `result`/`session_id`, and raises loudly if a `run.terminal.completed`
  event is missing it — provenance a caller can't record is treated as a
  failure, not an empty artifact. `run_agent()` stamps `provider` onto every
  reply. For the muse-routed planning step, `step_agent.py` writes both into
  the step's `artifacts`, which `server/src/orchestrator.js` persists on the
  new `step_run.provider` / `step_run.command_id` columns and folds into the
  step's summary line, so a human reads it in the activity feed without
  inspecting config.
- **Sandbox — nothing was relaxed.** Muse's sandbox network defaults to
  proxy-only (see the flags table above), but that only governs network
  calls made from *inside* Muse's own sandbox. The call to the Horizon
  server happens outside it: `farm/step_agent.py`'s process posts the result
  over HTTP after the `muse` subprocess has already exited. `--disable-sandbox`
  and `--sandbox-network` are never passed by this provider — the minimum
  needed for a headless run to reach the Horizon server was nothing.
- **Tests.** `farm/tests/test_providers_muse.py` covers command_id
  extraction/failure and a recorded-fixture JSONL parse (mocked subprocess —
  runs in CI). `farm/tests/test_step_agent.py` covers persona-based dispatch
  through `run_agent()` (never a direct call into this module) and the
  implement/deploy exclusion. `farm/tests/test_e2e_muse.py` is the opt-in
  counterpart that needs a real, authenticated `muse` CLI — see its
  docstring for the exact command; it is not part of the CI-gating suite. Its
  provenance test also asserts wall-clock duration against the step's
  configured timeout budget (half of it, as a healthy-run margin, not just
  "didn't hit the OS-level timeout") — a run that only barely finishes is
  treated as a failure here even though it would return normally.
- **Verified live**, not just mocked: with `muse` installed and authenticated
  on this host, `FARM_MUSE_E2E=1 python3 -m pytest farm/tests/test_e2e_muse.py
  -v -s` passed all 3 tests (73.20s total) — session continuity across two
  separate `muse exec` processes, the terminal-event parse against a live
  reply, and one real planning step dispatched through
  `step_agent.execute()` that recorded `provider=muse` and a real
  `command_id` (`372480e2-073c-42c4-8ad0-dc9eec05a836`) well inside its
  1140s budget. Raw terminal output is attached at
  [`muse-e2e-evidence.log`](./muse-e2e-evidence.log) — not a number typed
  into this doc.

## Reproducing these checks

```bash
export PATH="$HOME/.local/bin:$PATH"
muse --version
muse exec --json 'Reply with exactly the word: horizon' > out.jsonl
python3 - <<'PY'
import json
evs=[json.loads(l) for l in open('out.jsonl') if l.strip()]
term=[e for e in evs if e['payload_type']=='run.terminal.completed'][0]
print(term['payload']['text'], term['payload']['command_id'])
PY
```
