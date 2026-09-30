# `hzpoll` — the HZ-142 patch to the WhatsApp bridge

Horizon's gate notifications carry a native WhatsApp poll (**✅ Approve** /
**↩️ Send back**). Creating that poll and forwarding the tap needs code inside
the bridge, which is third-party: [`lharries/whatsapp-mcp`](https://github.com/lharries/whatsapp-mcp),
a Go process on [whatsmeow](https://github.com/tulir/whatsmeow). So the bridge
is now a **fork**, and this directory is the fork's patch.

## Why the patch lives here and not only in the fork

The fork has no CI. An out-of-repo Go process holding vote decryption,
durability ordering and retry policy would be gated by nothing at all — QA
blocked the plan over exactly that. Everything in `hzpoll/` is reachable from
`go test ./...`, which `npm test` at the repo root runs (see
`run-checks.sh`). What is left in the fork's own `main.go` is the wiring
below: about forty lines with no branching in them.

`hzpoll` is **stdlib-only** and never imports whatsmeow. The two things that
need it sit behind interfaces (`PollSender`, and the caller's own event
handler), so this module builds and tests on a host with no network and no
module cache.

## Phase 0

Whether the pinned whatsmeow can create polls and decrypt votes was settled
before any of this was written: see [`PROBE.md`](PROBE.md). It can.

## Wiring it into the fork

Copy `hzpoll/` into the fork's `whatsapp-bridge/` directory (or add this repo
as a module dependency — copying keeps the fork's rebase burden lower), then
make these four additions to `main.go`.

**1. The whatsmeow half of `PollSender`:**

```go
type meowPollSender struct{ client *whatsmeow.Client }

func (s meowPollSender) SendPoll(recipient, name string, options []string) (string, error) {
	jid, err := parseRecipient(recipient) // the same parse /api/send already does
	if err != nil {
		return "", err
	}
	msg := s.client.BuildPollCreation(name, options, 1)
	resp, err := s.client.SendMessage(context.Background(), jid, msg)
	if err != nil {
		return "", err
	}
	return resp.ID, nil
}
```

**2. The route, alongside the existing `/api/send` in `startRESTServer`:**

```go
http.HandleFunc("/api/send-poll", hzpoll.SendPollHandler(meowPollSender{client}))
```

**3. The forwarder, built at boot and validated there** — a missing credential
must be a startup failure, not a tap that vanishes at 3am:

```go
store := &hzpoll.SQLVoteStore{DB: messageStore.db}
if err := store.Migrate(); err != nil { log.Fatalf("poll_votes: %v", err) }
forwarder := &hzpoll.Forwarder{
	Store:    store,
	Endpoint: os.Getenv("HORIZON_VOTE_URL"),
	Secret:   os.Getenv("WA_APPROVAL_SECRET"),
	Log:      func(f string, a ...any) { fmt.Printf(f+"\n", a...) },
}
if err := forwarder.Validate(); err != nil { log.Fatalf("hzpoll: %v", err) }
// Replays any tap that landed while the Horizon server was restarting.
if n, err := forwarder.ReplayPending(); err == nil && n > 0 {
	fmt.Printf("hzpoll: replayed %d pending vote(s)\n", n)
}
```

**4. The event hook, at the top of `handleMessage`:**

```go
if msg.Message.GetPollUpdateMessage() != nil {
	vote, err := client.DecryptPollVote(context.Background(), msg)
	if err != nil {
		logger.Warnf("poll vote could not be decrypted: %v", err)
		return
	}
	option, err := hzpoll.ResolveSelected(vote.GetSelectedOptions(), hzpoll.Options)
	if err != nil {
		logger.Warnf("poll vote ignored: %v", err) // deselection, or an unknown option
		return
	}
	if err := forwarder.Handle(hzpoll.Vote{
		VoteID:    msg.Info.ID,
		PollMsgID: msg.Message.GetPollUpdateMessage().GetPollCreationMessageKey().GetID(),
		VoterJID:  msg.Info.Sender.String(),
		Option:    option,
	}); err != nil {
		logger.Warnf("poll vote not forwarded: %v", err) // committed; replays at boot
	}
	return // NEVER fall through to the messages table — see below
}
```

That `return` is load-bearing. `farm/whatsapp/mcp_bridge.py`'s `fetch_new()`
hands every new `messages` rowid to the concierge, which is a model call. A
vote written there would reach `run_agent` and reproduce the exact bug this
item removes. Votes go to `poll_votes`, which `fetch_new` never reads;
`sendpoll_test.go` fails if `VoteTableDDL` so much as names `messages`.

## Env the fork needs

| Var | | |
|---|---|---|
| `HORIZON_VOTE_URL` | required | e.g. `http://127.0.0.1:3001/api/wa/poll-vote` |
| `WA_APPROVAL_SECRET` | required | must equal the Node server's value. **Never `FARM_SHARED_SECRET`** — HZ-140 removed that from this path because every agent session inherited it. |

Both are validated at boot. See `infra/host/DEPLOY.md` §2c.

## Running the checks

```sh
bash infra/whatsapp-bridge/run-checks.sh   # gofmt -l, go vet, go test
```

`npm test` at the repo root runs the same script, and it skips with a warning
on a host with no Go toolchain — the same discipline `farm/checks.py` uses for
a check runner that is not installed.

## Re-pinning upstream

The patch is four additions to one file plus a copied directory, which is the
whole reason it is shaped this way. Record the fork's commit next to the
upstream pin in `farm/README.md`, and re-run `PROBE.md`'s probe 3 on every
re-pin: it is a fact about upstream's `extractTextContent`, not a guarantee.
