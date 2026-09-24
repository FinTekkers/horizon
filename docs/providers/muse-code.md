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
