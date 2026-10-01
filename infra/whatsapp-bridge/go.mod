module github.com/FinTekkers/horizon/infra/whatsapp-bridge

// STDLIB ONLY, deliberately. This module is the patch the forked whatsapp-mcp
// bridge applies, and it is gated by `npm test` at the repo root — so it has to
// build and test on a host with no network and no module cache. whatsmeow lives
// on the other side of the two interfaces in hzpoll (PollSender, VoteStore),
// never in here. testdata/probe/ is where the one file that DOES need whatsmeow
// lives; Go excludes testdata/ from ./... for exactly this reason.
go 1.22
