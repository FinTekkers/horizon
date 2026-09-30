# HZ-142 Phase 0 — can the pinned whatsmeow build create polls and decrypt votes?

Success metric 1: *"The pinned whatsmeow version's ability to create polls and
decrypt votes is verified and recorded in the PR. If not supported, the item
stops here and says so."*

**Result: supported. All four probes pass. The item proceeds.**

The probe is `testdata/probe/hz142_probe_test.go`. It is `package main` so it
compiles **inside the paired bridge checkout** and calls that checkout's own
functions — probe 3 would prove nothing against a copy of them. It lives under
`testdata/` because Go excludes that directory from `./...`, which keeps the
gated `hzpoll` module stdlib-only (see `go.mod`).

## What was probed, and against what

| | |
|---|---|
| Bridge | `lharries/whatsapp-mcp` @ `7d6a06dcdce1f01dfb24f60e1030d5efba9f3b88` |
| whatsmeow | `go.mau.fi/whatsmeow v0.0.0-20260730092514-662ad1dc6900` |
| Go toolchain | `go1.25.0 linux/arm64` |

## Re-running it

```sh
cp infra/whatsapp-bridge/testdata/probe/hz142_probe_test.go <bridge>/whatsapp-bridge/
cd <bridge>/whatsapp-bridge && go test -run TestProbe -v ./...
rm hz142_probe_test.go   # it is not part of the fork
```

## Raw output

```
=== RUN   TestProbe0_pinnedVersions
PROBE0 whatsmeow=v0.0.0-20260730092514-662ad1dc6900
PROBE0 go=go1.25.0
--- PASS: TestProbe0_pinnedVersions (0.00s)
=== RUN   TestProbe1_createPoll
PROBE1 PASS name="HZ-142 — Review before execution" options=["✅ Approve" "↩️ Send back"] selectable=1 secretBytes=32
--- PASS: TestProbe1_createPoll (0.00s)
=== RUN   TestProbe2_voteDecodesToAnOptionName
PROBE2 PASS selectedHash=b1fb54f6a94dcf29e1d8069e4642fb6ab10fc2c5166baad7376047feb4ec4906 resolvedOption="↩️ Send back"
--- PASS: TestProbe2_voteDecodesToAnOptionName (0.00s)
=== RUN   TestProbe3_pollMessagesAreNotStorableRows
PROBE3 PASS PollCreationMessage content="" mediaType="" -> no messages row
PROBE3 PASS PollUpdateMessage content="" mediaType="" -> no messages row
--- PASS: TestProbe3_pollMessagesAreNotStorableRows (0.00s)
PASS
ok  	whatsapp-client	0.008s
```

## Probe 1 — creating a poll

`(*whatsmeow.Client).BuildPollCreation(name, options, 1)` exists and returns a
`PollCreationMessage` carrying both option names byte-intact, a
`SelectableOptionsCount` of 1, and a 32-byte `MessageContextInfo.MessageSecret`
— the key the vote is later encrypted against. Nothing about it is
Business-Cloud-API-only.

## Probe 2 — decrypting a vote

`(*whatsmeow.Client).DecryptPollVote(ctx, *events.Message) (*waE2E.PollVoteMessage, error)`
exists on the pinned build. The probe pins its signature at compile time and
then exercises the whole data path it produces: a `PollVoteMessage` of
**SHA-256 digests of the option names** — never the names themselves —
marshalled, unmarshalled and matched back to `"↩️ Send back"`.

`hzpoll.HashOptions` is the matching side, and the two digests it produces are
pinned in `hzpoll/poll_test.go` against the values whatsmeow generated here:

```
sha256("✅ Approve")    = 478e7efeac9f1417082bcbd8ce1f6b794005302571318226295be1ceb4c5087b
sha256("↩️ Send back") = b1fb54f6a94dcf29e1d8069e4642fb6ab10fc2c5166baad7376047feb4ec4906
```

**What probe 2 does not cover.** The AES/HKDF layer inside `decryptMsgSecret`
needs a live paired session and a real inbound `PollUpdateMessage`, so it
cannot run offline or in CI. What is verified here is that the function exists
on the pinned build, takes the arguments the fork passes it, and yields a
plaintext shape the fork can resolve. **Before `WA_POLL_ENABLED` is turned on
for the first time, an operator must send one real poll and tap it** — see
`infra/host/DEPLOY.md` §2c for the two commands and the expected log line.

## Probe 3 — does a poll become an inbound message?

Asked by the architecture review, and the reason the bot marker question is
settled with evidence instead of an assumption.

`farm/whatsapp/mcp_bridge.py`'s `fetch_new()` hands every new `messages` rowid
to the concierge, which is a model call. If a poll creation or a poll vote
landed in that table, the poll question would be read as an inbound command and
would reach `run_agent` — reproducing the exact false-"processing that approval
now" bug this item exists to remove.

It does not. `handleMessage` in the bridge's `main.go` stores a row only when
`extractTextContent` or `extractMediaInfo` returns something, and the probe
calls **those two functions** with a real `PollCreationMessage` and a real
`PollUpdateMessage`. Both return empty, so `handleMessage` hits its
`"Skip if there's no content and no media"` branch and writes nothing.

Two things follow, and both are built on:

1. The fork must keep it that way. `hzpoll.VoteTableDDL` creates `poll_votes`,
   its own table, and `sendpoll_test.go` fails if that DDL so much as names
   `messages`.
2. The poll question is still sent **marker-prefixed** anyway. Probe 3 is a
   fact about today's upstream `extractTextContent`, and an upstream re-pin
   that taught it to read `PollCreationMessage.Name` would silently undo it.
   The marker costs one 🤖 in the poll title — the same one already on every
   gate notification the human receives — and buys a second, independent
   reason the concierge can never react to it. See `server/src/waSend.js`.
