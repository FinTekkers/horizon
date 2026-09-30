# Self-deploy: one-time host setup

After this PR merges, a published GitHub Release on a repo registered in
`infra/host/deploy-targets.json` pulls straight to the host via a webhook —
no more SSHing in to update it. This is the one-time setup that wires that
up. Do it once per target; every deploy after that is automatic.

## 0. The deploy-target registry

`infra/host/deploy-targets.json` is a versioned, git-reviewed file — not a
database row and not editable from the Admin UI — mapping each deployable
repo to the script that deploys it, the systemd service it restarts, and its
own state directory (`~/.horizon/<stateKey>/`). `server/src/deploy.js` looks
up the webhook's `repository.full_name` in this file; a repo absent from it
is rejected and logged, never deployed. Adding a new target means adding an
entry here, a deploy script under `infra/host/`, and a sudoers line (below)
— all three require a reviewed PR, by design.

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
| `/etc/horizon/server.env` | `WA_BRIDGE_URL` | whatsapp-mcp bridge base URL. Unset ⇒ `http://localhost:8080`. Same var `farm.env` already sets |

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
curl -s localhost:8080/api/send-poll -H 'Content-Type: application/json' \
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
   `infra/host/deploy-targets.json`.)
3. **Restart-survival check** — this is the part that can't be verified any
   other way than on the live box: watch that `deploy-horizon.sh` actually
   survives the `systemctl restart horizon-server` it triggers partway
   through its own run, rather than being killed along with the process that
   spawned it. `journalctl -u horizon-server -f` in one terminal while a
   release publishes should show the restart happen, and `self-deploy.log`
   should still get a `DEPLOY OK` (or a clearly logged `DEPLOY FAILED:
   health-check ...`) after it — not silence, because the script died
   mid-run.

If a deploy ever fails its health check, the bad code is already live (the
script does not auto-rollback); redeploy the last good tag by hand, using
the target's own script and state directory:

```
infra/host/deploy-horizon.sh "$(cat ~/.horizon/horizon/last-good-tag | cut -d: -f1 | sed 's#refs/tags/##')"
```

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
   an SSR frontend — and adjust its build/health-check stages).
2. Add an entry to `infra/host/deploy-targets.json`: `key`, `repo`, `script`,
   `service`, `repoDir`, `stateKey`, `healthUrl`, `healthCheckType`.
3. Add an explicit sudoers line for the new service to
   `infra/host/horizon-deploy.sudoers` and re-apply it on the host (step 1
   above) — a registry entry with no matching sudoers line fails closed at
   the `restart` stage (`DEPLOY FAILED: restart`), it does not deploy with
   elevated privilege.
4. Add the **Releases** webhook event on the new repo (step 4 above).

All three of steps 1-3 land in the same reviewed PR; nothing about a deploy
target is editable outside of git.
