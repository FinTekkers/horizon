# Self-deploy: one-time host setup

After this PR merges, a published GitHub Release on a repo with a deploy
target pulls straight to the host via a webhook —
no more SSHing in to update it. This is the one-time setup that wires that
up. Do it once per target; every deploy after that is automatic.

## 0. The deploy-target registry

Deploy targets live in Horizon's database, the `deploy_target` table (HZ-263),
mapping each deployable repo to the script that deploys it, the systemd
service it restarts, and its own state directory (`~/.horizon/<stateKey>/`).
The first server start seeds it once from a snapshot in
`server/src/deployTargets.js`. `server/src/deploy.js` looks up the webhook's
`repository.full_name` in this table; a repo with no row is rejected and
logged, never deployed. Every resolve re-validates the row — its script must
resolve inside `infra/host/`, and its service and extra services must appear
as `systemctl restart` lines in `infra/host/horizon-deploy.sudoers` — and a
row that fails is logged and not deployed. Deploy scripts and the sudoers
line (below) still require a reviewed PR, by design.

## 1. Install the sudoers rule

Each target's deploy script needs to restart its own service without a
password prompt, and nothing broader. The template
(`infra/host/horizon-deploy.sudoers`) names every service explicitly — a
target must appear in **both** the registry and this file to be deployable,
so a bad registry entry alone can never restart an arbitrary service. Never
widen this to a wildcard.

```
sudo cp infra/host/horizon-deploy.sudoers /etc/sudoers.d/horizon-deploy
sudo visudo -c
```

`visudo -c` must report no syntax errors before continuing.

## 2. Apply the systemd unit change

This PR adds `KillMode=process` to `horizon-server.service` — without it,
`systemctl restart horizon-server` would kill `deploy-horizon.sh` itself
(it's forked from the Node process handling the restart request) before it
can finish its health check.

```
sudo cp infra/host/horizon-server.service /etc/systemd/system/horizon-server.service
sudo systemctl daemon-reload
sudo systemctl restart horizon-server
```

## 2b. WhatsApp gate-approval env (HZ-140)

Set these **before** the release ships, or every WhatsApp approval fails
closed. Names only below — values live on the host, never in this repo.

| File | Var | Notes |
|---|---|---|
| `/etc/horizon/server.env` | `WA_APPROVAL_SECRET` | the only credential that can approve a gate. Unset ⇒ the route answers **503** |
| `/etc/horizon/server.env` | `WA_APPROVER_JIDS` | comma-separated approver numbers. Unset/empty ⇒ **deny all**, every sender gets **403** |
| `/etc/horizon/farm.env` | `WA_APPROVAL_SECRET` | same value as the server's |

`FARM_SHARED_SECRET` stays where it is, in both files. It no longer opens the
approval route — it is farmd's credential for `/api/farm/*` and nothing else.

Diagnosing a failed approval without reading code:

- **503, "aren't configured on the Horizon server"** — `WA_APPROVAL_SECRET`
  missing from `server.env`.
- **401** — the two `WA_APPROVAL_SECRET` values disagree between
  `server.env` and `farm.env`.
- **403, "isn't on Horizon's approver list"** — the sender's number is
  missing from `WA_APPROVER_JIDS` on the server.
- **Silence, no reply at all** — the sender is missing from the farm's own
  `FARM_WA_ALLOWED_JIDS`, which drops the message before it is ever read.

After deploying, restart `horizon-server`, then restart farmd. Existing tmux
sessions keep the environment they were launched with, so a pre-upgrade
session still holds the old credential until farmd's teardown kills it.
Confirm with `python -m farm.tools.check_session_env` (names only, exits
non-zero on a find).

## 2c. Gate-arrival notification env (HZ-141)

Turns on the server-side notifier that messages the approver when an item
lands on a gate. **Off by default** — it messages a real human, so it is
never on by accident, and configuring HZ-140's approval path above does not
enable it.

| File | Var | Notes |
|---|---|---|
| `/etc/horizon/server.env` | `WA_NOTIFY_ENABLED` | `1` turns it on. Anything else ⇒ the sweep never runs |
| `/etc/horizon/server.env` | `WA_BRIDGE_URL` | whatsapp-mcp bridge base URL. Unset ⇒ `http://localhost:8080`. This host sets `http://localhost:8090` here and in `farm.env`: the bridge listens on `WA_BRIDGE_PORT=8090` (since 2026-10-07) so valuation-service keeps its default 8080 |

**Who gets notified is `WA_APPROVER_JIDS` from 2b — there is no separate
recipient setting.** Whoever can approve a gate is exactly who is told one is
waiting. `WA_NOTIFY_ENABLED=1` with an empty `WA_APPROVER_JIDS` logs a warning
at boot and delivers nothing.

Accepted entry formats, all equivalent — the server canonicalizes each one to
`<number>@s.whatsapp.net` before it reaches the bridge, so a bare number is a
valid setting for both approving and being notified:

| You write | Sent to | Note |
|---|---|---|
| `15551112222` | `15551112222@s.whatsapp.net` | the documented short form |
| `15551112222@s.whatsapp.net` | `15551112222@s.whatsapp.net` | already canonical |
| `15551112222:7@s.whatsapp.net` | `15551112222@s.whatsapp.net` | device suffix dropped — it addresses one phone, not the person |

Two entries that canonicalize to the same jid are one recipient, so a person
listed twice still gets one message per gate arrival. An explicit non-default
server part (`…@g.us`) is kept as written rather than rewritten.

No credential is on this path. `POST /api/send` takes no auth and is
localhost-only, so neither `FARM_SHARED_SECRET` nor `WA_APPROVAL_SECRET` is
read by the notifier.

### That the feature works is a test, not an ops step

`server/test/gate-notifier-e2e.test.mjs` boots the real `node src/server.js`
with `WA_NOTIFY_ENABLED=1` against a stub bridge on a real socket, lets the
pipeline walk items onto gates on its own, and asserts what the bridge
received and the exact row state below. It runs in `npm test`. Nothing on
this page needs a human to confirm the code sends messages — the steps that
follow confirm only that *this host's* configuration is right.

### Verifying this host's configuration

Restarting and waiting for a text is not a check — it has no observable if
nothing arrives. The outbox records every attempt, so read it back instead.
After `systemctl restart horizon-server`, drive one item to a gate (or wait
for one), then:

```
# HORIZON_DB is unset on this host, so the server uses its default path,
# relative to horizon-server.service's WorkingDirectory=/opt/horizon/server.
sqlite3 -header -column /opt/horizon/server/data/horizon.db \
  "SELECT item_id, step_index, status, attempts, last_error, sent_at
     FROM gate_notice ORDER BY id DESC LIMIT 5;"
```

Expected on success: one row per approver for that arrival, `status = sent`,
`attempts = 0`, `last_error` empty, `sent_at` set — the same four values
`gate-notifier-e2e.test.mjs` asserts, so a row that looks different here is a
configuration problem on this host, not a code problem.

- **No rows at all** — `WA_NOTIFY_ENABLED` is not `1`, or
  `WA_APPROVER_JIDS` is empty. Check the boot log for the notifier's own
  warning.
- **`status = pending`, `attempts ≥ 1`** — the bridge rejected or was
  unreachable; `last_error` says which. It retries with 60s doubling backoff
  and nothing about the item is affected.
- **`status = failed`, `last_error` set** — gave up after
  `WA_NOTIFY_MAX_ATTEMPTS` (default 8, ≈2h). Fix the bridge; this arrival is
  not resent.
- **`status = failed`, `last_error = interrupted…`** — the process exited
  mid-send. Deliberately not resent: one logged miss beats two pings about the
  same arrival.

To turn it off with no deploy: set `WA_NOTIFY_ENABLED=0` and restart
`horizon-server`. Nothing else changes.

## 2d. Approve-or-send-back poll env (HZ-142)

Each gate notification now also carries a native two-option WhatsApp poll —
**✅ Approve** / **↩️ Send back** — and a tap decides the gate with no model
anywhere on the path. The concierge's free-text approval is unchanged and
still works; whichever decides the gate first moves the cursor, and the
other is then refused as `ignored_stale_gate`.

**This needs the forked bridge.** An un-forked `whatsapp-mcp` has no
`POST /api/send-poll`, so every poll row fails with a 404 while every text
notice still goes out — see `infra/whatsapp-bridge/README.md` for the patch
and `infra/whatsapp-bridge/PROBE.md` for what was verified about the pinned
whatsmeow build before any of it was written.

| File | Var | Notes |
|---|---|---|
| `/etc/horizon/server.env` | `WA_POLL_ENABLED` | `0` stops attaching polls. Anything else ⇒ on whenever `WA_NOTIFY_ENABLED=1` |
| bridge env | `HORIZON_VOTE_URL` | e.g. `http://127.0.0.1:3001/api/wa/poll-vote`. The bridge refuses to start without it |
| bridge env | `WA_APPROVAL_SECRET` | **the same value as `server.env` and `farm.env`.** The bridge refuses to start without it |

`WA_APPROVAL_SECRET` now lives in **three** places — server, farm, bridge. A
mismatch on the bridge's copy is a 401 on every vote, and the poll itself is
silent about it, so it is the first thing to check when a tap does nothing.
**`FARM_SHARED_SECRET` is never used on this path**; it opens nothing here,
which is the whole point of HZ-140 and is asserted in
`server/test/wa-poll-vote-auth.test.mjs` — and again over a real socket, into
a really-booted `server.js`, in `server/test/wa-poll-vote-e2e.test.mjs`. That
second file is the one to read if a tap misbehaves in production: it drives an
Approve and a Send back through the same route the bridge calls, using a poll
id the bridge itself minted, so the whole join is exercised rather than mocked.

### Before turning it on for the first time

Probe 2 in `PROBE.md` verifies that the pinned whatsmeow exposes
`DecryptPollVote` and what shape it yields, but the AES/HKDF layer needs a
live paired session and cannot be exercised offline. So do it once, by hand:

```
# 1. Send yourself a poll through the forked bridge.
curl -s localhost:8090/api/send-poll -H 'Content-Type: application/json' \
  -d '{"recipient":"<your-number>@s.whatsapp.net","name":"probe","options":["✅ Approve","↩️ Send back"]}'
# -> {"success":true,"messageId":"3EB0…"}   the poll should render as tappable

# 2. Tap an option, then read the bridge's log. Expect a line naming the
#    resolved option. A decryption failure logs "poll vote could not be
#    decrypted" instead — stop and report it rather than working around it.
```

### Reading the poll outbox

Polls have **their own** outbox, separate from `gate_notice`, so a bridge
that cannot serve `/api/send-poll` never suppresses a text notification.

```
sqlite3 -header -column /opt/horizon/server/data/horizon.db \
  "SELECT item_id, step_index, status, attempts, poll_msg_id, decided_at, last_error
     FROM gate_poll ORDER BY id DESC LIMIT 5;"
```

Expected on success: one row per approver per arrival, `status = sent`,
`attempts = 0`, `poll_msg_id` set, `decided_at` empty until someone taps.

- **No rows at all** — `WA_POLL_ENABLED=0`, or `WA_NOTIFY_ENABLED` is not `1`.
- **`status = pending`, `last_error` mentions 404** — the bridge is not the
  fork. Text notices are unaffected; apply the patch or set
  `WA_POLL_ENABLED=0`.
- **`status = pending`, `last_error` mentions `messageId`** — the bridge sent
  a poll and returned no id. Treated as a failure on purpose: an untracked
  poll is tappable and decides nothing.
- **`status = failed`, `last_error = interrupted…`** — the process exited
  mid-send. That poll may be on a phone with no id recorded here, so a tap on
  it logs `ignored_unknown_poll` and does nothing. Not resent, same
  at-most-once rule as a text notice.

### Diagnosing a tap that did nothing

The server logs one line per refused vote (`wa poll vote <id> ignored: …`).
Every refusal is a **4xx**, which the bridge treats as final and never
retries.

| In the log / response | Means |
|---|---|
| `503 wa_approval_not_configured` | `WA_APPROVAL_SECRET` missing from `server.env` |
| `401 bad_approval_secret` | the bridge's copy disagrees with the server's |
| `403 voter_not_allowed` | the voter's number is missing from `WA_APPROVER_JIDS` |
| `404 ignored_unknown_poll` | no `gate_poll` row for that poll — usually an interrupted send, above |
| `409 ignored_superseded` | an older poll for an item that has since arrived again |
| `409 ignored_stale_gate` | the item has left that gate — often because the concierge or the UI decided it first |
| `409 ignored_already_decided` | someone else's tap got there first |
| `422 ignored_unknown_option` | the option strings drifted between the bridge and the server |

To turn it off with no deploy: set `WA_POLL_ENABLED=0` and restart
`horizon-server`. Polls stop being attached; text notices and the concierge's
free-text approval carry on. **The vote route stays live either way**, so a
poll already on someone's phone still decides its gate.

## 2e. Farm capacity env (HZ-144)

The farm's two concurrency limits live in `/etc/horizon/farm.env`, loaded by
`infra/host/horizon-farm.service`. **That file is not in git**, so "set
explicitly in the deployed farm config" is a host edit, not a reviewable
diff — this section is the reviewable record of it.

It is a **prescription, not a log**: the values below are what this host is to
run, applied by whoever deploys the change. Nothing in the repo can assert
they were applied, so confirm them with the commands at the end of this
section rather than trusting this table. As of the HZ-144 PR the mechanism is
in the code and the host edit has **not** been made — `FARM_MAX_EPHEMERAL` is
unset on this host, so the code default of 4 is in force.

| File | Var | Value to set | Notes |
|---|---|---|---|
| `/etc/horizon/farm.env` | `FARM_MAX_EPHEMERAL` | `6` | how many agent steps run at once. The code default in `farm/farmd.py` stays **4** on purpose: raising the default would silently re-raise the cap on every other host |
| `/etc/horizon/farm.env` | `FARM_MAX_CONCURRENT_CHECKS` | `2` | how many check suites run at once. **Set this before raising the line above** |
| `/etc/horizon/farm.env` | `FARM_CHECK_SLOT_WAIT_MAX_S` | (unset ⇒ 1200) | how long a run waits for a check slot before proceeding **without** one. Sized above the worst legitimate queue (2 waves × the measured p95 suite) and below the step watchdog — do not lower it to "fail faster", that disables the cap under load |
| `/etc/horizon/farm.env` | `FARM_CHECK_METRICS_PHASE` | measurement only | tags records during a measurement window; remove it afterwards |

The exact lines:

```
FARM_MAX_CONCURRENT_CHECKS=2
FARM_MAX_EPHEMERAL=6
```

Then `sudo systemctl restart horizon-farm`. Existing tmux sessions keep the
environment they were launched with, so the restart's teardown is what
applies the new values.

**Order matters.** Six agents all reaching their checks at once on 2 vCPUs is
the failure this pairing exists to prevent — it was observed live on 30 Sept
2026 (load ~8, the Playwright suite failing its own 85s budget). Add
`FARM_MAX_CONCURRENT_CHECKS` first, restart, confirm, then raise
`FARM_MAX_EPHEMERAL`.

Confirm afterwards:

```
curl -s localhost:4100/farm/status | python3 -m json.tool   # agents.limit, checks.limit
tmux list-sessions | grep -c farm-run-                      # never exceeds agents.limit
farm/.venv/bin/python -m farm.tools.check_session_env       # no INFO line about FARM_MAX_EPHEMERAL
```

The last one matters: farmd holds `FARM_MAX_EPHEMERAL` and must not pass it
into an agent session. The checked repo is Horizon, whose own suite asserts
the default, so a leak there fails every implement run's pytest rather than
showing up as a warning. It prints an `INFO` line (not a `LEAK`, and not a
non-zero exit — that status is reserved for credentials).

### Rolling back

All three levers are config; no code revert is needed.

- Too much contention: `FARM_MAX_EPHEMERAL=4`, restart.
- The limiter itself is suspect: `FARM_MAX_CONCURRENT_CHECKS=0`, restart —
  `check_slot()` becomes a no-op and pre-HZ-144 behaviour is restored.
- Do **not** raise `FARM_CHECK_TIMEOUT_S` or the e2e `globalTimeout` to
  absorb slow checks. Both are the contention detectors; report the numbers
  from `python -m farm.tools.report_check_metrics` instead.
  Exception (2026-10-07, owner's call): `globalTimeout` went from 180s to
  360s because the suite alone reached 174-180s on a quiet host, so the
  limit no longer measured contention. HZ-327 replaces the fixed number.

Stale slot files under `$FARM_HOME/locks/checks/` need no cleanup — `flock`
state is held by the kernel, not by the files' contents.

## 2f. PM steps run per task (HZ-212)

There is no long-lived `farm-pm-<project>` session any more. farmd launches
each PM step (0, 1, 2, 9) as its own `farm-run-<item>-s<step>-a<attempt>`
session with its own `~/.horizon-farm/logs/<session>.log`, one at a time,
exactly like every other step. So a release's code reaches the next PM step
with no PM-specific restart. A `farm.env` change still needs the farmd
restart below, as it does for every step: farmd is the process that reads it.

**Cutover is the farmd restart.** At boot, before dispatching anything, farmd
kills any `farm-pm-*` session left by the old build. That session's in-flight
step has no farm record left, so the server fails it once with a retryable
reason (`timeout`, or `never_picked_up` after a server restart) and the
orchestrator retries it. Tasks still queued in `queue/pm` are left alone; the
dispatcher picks them up.

**Stale files, kept on purpose.** farmd reads none of these any more and
deletes none of them; it lists them in its log at every boot:

- `~/.horizon-farm/state/pm-session-<slug>.txt` — the last session id. PM
  steps never resume it.
- `~/.horizon-farm/logs/pm-<slug>.log` — the old PM's combined log.

Archive them once you no longer need them.

**Rolling back.** Revert the release and restart farmd. The old watchdog
relaunches `farm-pm-<slug>`, which resumes the id in `pm-session-<slug>.txt`.
The new build keeps writing that file, so it holds the session of whichever
PM step ran last — one unrelated item's context. That is harmless: every PM
prompt already carries the item and its project context. A PM step still in a
`farm-run-*` session finishes and reports through the unchanged
`/internal/steps/result`.

## 2g. Rules signing secret (HZ-246)

Project and repo rules saved in Admin are versions in Horizon's DB, each
signed with this secret; agents are only ever served a version whose
signature checks out. Set it **before** the release ships, or rules saves fail
closed. Names only — the value lives on the host.

| File | Var | Notes |
|---|---|---|
| `/etc/horizon/server.env` | `RULES_HMAC_SECRET` | a long random string, e.g. `openssl rand -hex 32`. Unset ⇒ saves and restores answer **503** and agents get only the `farm/rules/*.md` files |

**Never** put it in `farm.env`: agents are launched from there. Changing it
later makes every saved version fail its check (agents fall back to the
files, Admin shows each version as tampered) — set it once.

A version edited straight in SQLite fails its check: it is skipped, the
newest version that still verifies is served instead (else the file), and the
server logs `rules: TAMPER scope=… key=… version=…`. Accepted risk: an agent
running as this OS user can read the server's environment, so this catches
naive or accidental DB edits, not a determined forger.

## 3. Confirm the repo is pull-only

`/opt/horizon` must be able to `git fetch`/`checkout` from `origin`, but must
**not** hold any push credential (no GitHub-held SSH key, no token with
`contents:write` in its remote URL) — deploys are pull-only by design.

```
cd /opt/horizon && git remote -v
```

If `origin` is an `https://github.com/...` URL with no embedded token, or an
SSH remote using a read-only deploy key, you're good.

## 4. Add the Releases event to the webhook

In the `FinTekkers/horizon` repo settings → Webhooks, edit the webhook already
pointed at `https://shoreward.ai/horizon/api/webhooks/github` (it already
verifies `issues`/`issue_comment`/`pull_request` events with
`GITHUB_WEBHOOK_SECRET`) and add the **Releases** event. No new secret needed.

## 5. Verify end to end

1. Publish a test release (or just wait for the next work item's Deploy
   step — it publishes one automatically).
2. Confirm `~/.horizon/horizon/self-deploy.log` on the box shows a line like:
   ```
   DEPLOY OK tag=refs/tags/<tag> commit=<sha>
   ```
   (each target logs to its own `~/.horizon/<stateKey>/self-deploy.log`, per
   its `deploy_target` row.)
3. **Restart-survival check** — this is the part that can't be verified any
   other way than on the live box: watch that `deploy-horizon.sh` actually
   survives the `systemctl restart horizon-server` it triggers partway
   through its own run, rather than being killed along with the process that
   spawned it. `journalctl -u horizon-server -f` in one terminal while a
   release publishes should show the restart happen, and `self-deploy.log`
   should still get a `DEPLOY OK` (or a clearly logged `DEPLOY FAILED:
   health-check ...`) after it — not silence, because the script died
   mid-run.

The gRPC targets (`deploy-grpc-service.sh`, run by `deploy-ledger-service.sh`,
`deploy-valuation-service.sh`, `deploy-broker-service.sh` and
`deploy-price-service.sh`) roll back automatically: when the health check
fails after the restart, the script checks out the `last-good-tag` commit
detached (no fetch), rebuilds, restarts and health-checks it once, with the
same timeout and still holding the deploy lock. `self-deploy.log` gets the
`DEPLOY FAILED: health-check ... ; rolling back to <ref>` line, then
`ROLLBACK OK tag=<last good> after <failed>` or `ROLLBACK FAILED (<stage>)`.
With no `last-good-tag` (first deploy) it logs `ROLLBACK SKIPPED: no
last-good-tag`. The deploy still fails (exit 1), `last-good-tag` keeps the old
tag, and a failure before the restart (fetch, checkout, build) never rolls
back. A rollback holds the lock for one more build plus one health timeout
(ledger: a gradle build plus 180s), so a deploy queued behind it can wait out
its 300s lock timeout and log `DEPLOY FAILED: lock`; publish it again.

Other targets (`horizon`, `ui-service`) still do not auto-rollback: if one
fails its health check the bad code is already live; redeploy the last good
tag by hand, using the target's own script and state directory (the same
command works for a gRPC target whose rollback failed):

```
infra/host/deploy-horizon.sh "$(cat ~/.horizon/horizon/last-good-tag | cut -d: -f1 | sed 's#refs/tags/##')"
```

To have a manual run drain running checks first (below), as a webhook deploy
does, give it the drain URL and the farm secret:

```
HORIZON_DEPLOY_DRAIN_URL=http://127.0.0.1:3001/api/farm/deploy-drain \
FARM_SHARED_SECRET="$(sudo sh -c '. /etc/horizon/server.env; printf %s "$FARM_SHARED_SECRET"')" \
  infra/host/deploy-horizon.sh "<tag>"
```

## Drain before restart (HZ-250)

`systemctl restart horizon-server` used to strand another item's running
pre-merge checks: the checker is spawned detached and `KillMode=process`
leaves it alive with nobody to read its result, and its `gate_action` row
sat `running` until its lease ran out. `deploy-horizon.sh` now has a `drain`
stage, inside its `flock`, just before `restart`:

1. It asks the server (`POST /api/farm/deploy-drain`, loopback only, farm
   secret) to refuse new runs. Accept, WhatsApp approve, the approval poll and
   Resolve-conflicts then answer **409** `deploy in progress, try again in a
   few minutes`; auto-resolve logs `skipped (deploy in progress)` and starts
   nothing.
2. It waits for every running `premerge`/`resolve` run, polling, up to
   `HORIZON_DEPLOY_DRAIN_TIMEOUT_S` (default **1500** = 25 min; `0` = don't
   wait). `self-deploy.log` gets a `DRAIN waiting …` line naming each item and
   kind, then `DRAIN finished: <item> <kind>` or `DRAIN timed out: <item>
   <kind> — interrupted (server restarted for deploy)`.
3. Runs still going when the wait ends are marked `interrupted`, reason
   `server restarted for deploy`, and each pre-merge checker's process group
   is stopped (SIGTERM, then SIGKILL) before the restart.

The block lives in the server's memory: the restart clears it, a failed
deploy's `ERR` trap clears it (`DRAIN released`), and it expires by itself
after the longer of the two waits (HZ-321, below) + both interrupt bounds +
10 min (never more than `DEPLOY_BLOCK_MAX_TTL_S`, default 2 h, in
`server.env`). No DB edit is ever needed.

The drain never stops a deploy: a server that is down, hung or erroring is
logged as `DRAIN skipped: …` and the restart goes ahead. Each request has its
own bound (`HORIZON_DEPLOY_DRAIN_REQUEST_TIMEOUT_S`, default 10 s; the
interrupt `HORIZON_DEPLOY_DRAIN_INTERRUPT_TIMEOUT_S`, default 60 s). The
server sets `HORIZON_DEPLOY_DRAIN_URL` for the `horizon` target only — the
`ui-service` deploy is unchanged — and a deploy started by a server older
than HZ-250 has no drain stage. Off switch: set
`HORIZON_DEPLOY_DRAIN_TIMEOUT_S=0` in `server.env`.

Known gap (HZ-256): an interrupted `resolve` run's resolver is not stopped
here — it runs inside farmd, which this script restarts right after
`horizon-server`. farmd will not re-launch it: `/conflicts/resolve` runs
inline in a thread and writes no task file (`farm/farmd.py`
`conflicts_resolve`), and `_adopt_existing()` only re-adopts step runs from
`queue/runs/active/*.json`.

### Running agent steps (HZ-321)

The same deploy also restarts the farm (an `extraServices` entry of the
`horizon` target), which ends every running agent step's tmux session. The
drain now waits for those steps too, so a deploy no longer throws their work
away:

1. While the block is on, the server starts no new agent step. A dispatch
   asked for meanwhile is held, not dropped. This covers every project,
   including `ui-service` deploy steps.
2. The drain waits for every running agent step, polling in the same loop as
   the gate runs, up to `HORIZON_DEPLOY_DRAIN_STEP_TIMEOUT_S` (default
   **1500** = 25 min; `0` = don't wait). `self-deploy.log` gets
   `DRAIN waiting up to <n>s for <k> agent step(s): <item> <step>, …`, then per
   step `DRAIN finished: <item> <step>` or `DRAIN timed out: <item> <step> —
   checkpointed, requeued after deploy`. `<step>` is the step label as one
   word, e.g. `specialist-agent-implements`.
3. A step still going when its wait ends is stopped with a checkpoint. The
   farm SIGTERMs the step agent, which commits its whole working tree as one
   WIP commit (`cause: deploy`). `.gitignore` is honoured and secret-looking
   files are left out. The agent pushes that commit to `horizon/<item>` only,
   as a plain fast-forward: never forced, never rewriting a commit. The run
   is closed as deploy-interrupted. Its feedback goes back undelivered, and
   after the restart the server dispatches the step again **at the same
   attempt and auto-retry count**. The next attempt starts from the
   checkpoint commit.
4. A checkpoint that fails or does not answer in time logs
   `DRAIN checkpoint failed: <item> <step> (<why>)`, and the restart goes
   ahead. A failed push leaves the commit in the item's worktree, and the
   next attempt resumes from it. The checkpoint wait is
   `min(HZ_PAUSE_CHECKPOINT_TIMEOUT_S, 40)` s, so the server's answer always
   lands inside the 60 s interrupt bound.

Bound: the drain ends within `max(HORIZON_DEPLOY_DRAIN_TIMEOUT_S,
HORIZON_DEPLOY_DRAIN_STEP_TIMEOUT_S)` + one begin and one status request +
two interrupt requests. With the defaults that is 1500 + 10 + 10 + 2 × 60 =
**1640 s**. Off switch for steps: `HORIZON_DEPLOY_DRAIN_STEP_TIMEOUT_S=0`,
which checkpoints at once and does not wait.

Notes:

- **The deploy step is not drained.** Its own run published the release
  being deployed, and it waits for that deploy to go live, so waiting for it
  would wait on itself. It still ends when the farm restarts, as before.
- **`drain release` resumes items.** When a deploy fails before the restart,
  the `ERR` trap's release (or the block's TTL running out) dispatches the
  held and deploy-stopped steps on the server that is still running.
- **First rollout.** The deploy that ships HZ-321 runs the new helper
  against the old server, which lists no `steps`. Steps are drained from the
  next deploy on.
- **Re-adopt.** A farm restart on its own (farmd only) already re-adopts a
  live `farm-run-*` session. `systemctl restart horizon-farm` ends the
  sessions, which is why the drain checkpoints them first. The systemd units
  and the sudoers file are unchanged.

## Deploy queue: one release per batch (HZ-333)

Step 14 no longer publishes a release per item. An item joins its deploy
target's queue (`server/src/deployQueue.js`, rows in `deploy_batch` and
`deploy_queue_entry`) and records its PR's merge commit. Library targets
(`registry-publish`) and items with no PR keep the per-item release.

- **Window.** `HORIZON_DEPLOY_BATCH_S` in `server.env` (default `900`; `0`
  means no window) counts from the first join. When it has passed and nothing
  is deploying on that target, Horizon reads main's head and publishes **one**
  release pinned to it. The webhook deploys it as before. Targets are
  independent; one target runs one deploy at a time.
- **Tag.** `deploy-<target>-<yyyymmdd>-b<batch id>`, e.g.
  `deploy-horizon-20261007-b7`. It is saved before the GitHub call and looked
  up first on every retry or restart, so a batch never publishes a second
  release and never a `-2` tag. Rollback is unchanged: re-run the script with
  the tag from `last-good-tag`.
- **Live.** Once `last-good-tag` names the batch's tag, each queued item
  whose merge commit is an ancestor of the deployed commit runs its smoke
  check against that release; one merged after main was read waits for the
  next batch. `HORIZON_DEPLOY_WAIT_MS` counts from the batch's deploy start.
- **Failure.** `DEPLOY FAILED` for the tag in `self-deploy.log`, or no live
  deploy within `HORIZON_DEPLOY_WAIT_MS`, fails step 14 for every item in the
  batch, naming the tag and the items. Resuming an item re-queues it.
- **Hold.** A batch stays `verifying` until its items' smoke checks end, so
  the next batch cannot move `last-good-tag` under them. That holds the next
  batch for at most `FARM_STEP_TIMEOUT_MS + HORIZON_DEPLOY_WAIT_MS` after the
  batch went live.
- **Restart.** All state is in the database; the server resumes each batch
  where it stopped at boot. A Horizon batch is one release, one deploy and one
  drain.

## Deep verification beyond the health check (HZ-22)

Each deploy script's health check proves the process restarted and answered
— it does not always prove the page a user loads actually renders (see
`deploy-horizon.sh`'s health check, which only confirms the API is up, vs.
`deploy-ui-service.sh`'s, which also confirms the SSR shell and its client
bundle really serve). `e2e/smoke/check.mjs` closes that gap for any target:
it loads a URL in a real headless browser and confirms expected content is
actually visible, not just that a response arrived.

```
node e2e/smoke/check.mjs https://shoreward.ai/horizon/ "Horizon" [screenshot.png]
```

Exits `0` with `SMOKE_RESULT=pass` only if the text renders; `1` with
`SMOKE_RESULT=fail: <reason>` otherwise.

This is now a real pipeline gate, not just a manual tool. The Deploy step
(`STEPS[14]` in `lifecycle.js`) is farm-dispatched by default: the JS
orchestrator still owns publishing the GitHub release itself (it holds the
GitHub token the farm doesn't), and only hands the step to the farm's
DevOps agent (`farm/roles/devops.md`) afterwards, for verification. The
agent picks the `url`/`expected_text` to check from the project rules, but
`farm/step_agent.py` — not the agent's own self-reported verdict — is what
actually runs `check.mjs` and reads its real exit code; that's the value
this script sends back as the deploy verdict. A failing verdict pauses the
item for a human rather than silently advancing (`server/src/orchestrator.js`
`finalizeDeployStep`), the same way a failing review verdict does.

## Adding a new target

1. Add a deploy script under `infra/host/` (copy the closest existing one —
   `deploy-horizon.sh` for a Node/systemd service, `deploy-ui-service.sh` for
   an SSR frontend — and adjust its build/health-check stages). A gRPC
   backend needs only a wrapper like `deploy-broker-service.sh`: it sets the
   `DEPLOY_*` variables (checkout, unit, port, build command) and execs
   `deploy-grpc-service.sh`, which health-checks with
   `grpc.health.v1.Health/Check`; give its row `health_check_type`
   `grpc-health`. Keep the unit file next to it (`fintekkers-*.service`).
   A library published by GitHub Actions on a `vX.Y.Z` tag gets a wrapper
   like `deploy-ledger-models.sh` around `deploy-publish-release.sh`: the
   deploy pushes the next patch tag on the release commit and waits for the
   publish workflows. Its row has `health_check_type` `registry-publish` and
   an empty `service` (nothing restarts, so no sudoers line).
2. Add a row to the `deploy_target` table: `key`, `repo`, `script`,
   `service`, `repo_dir`, `state_key`, `health_url`, `health_check_type`
   (and `extra_services`, a JSON array).
3. Add an explicit sudoers line for the new service to
   `infra/host/horizon-deploy.sudoers` and re-apply it on the host (step 1
   above) — a row whose service has no sudoers line in the repo is rejected
   when the release resolves, and one missing from the host's installed copy
   fails closed at the `restart` stage (`DEPLOY FAILED: restart`); neither
   deploys with elevated privilege.
4. Add the **Releases** webhook event on the new repo (step 4 above).

Steps 1 and 3 land in a reviewed PR; a row whose script or service they do
not cover is logged and never deployed.
