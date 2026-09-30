// Package hzpoll is the HZ-142 patch to the forked whatsapp-mcp bridge: it
// creates the two-option gate poll and forwards decrypted votes to the Horizon
// server.
//
// It lives in the Horizon repo rather than only in the fork because the fork
// has no CI of its own — an out-of-repo Go process holding vote decryption,
// durability and retry logic would be gated by nothing at all. Everything here
// is reachable from `go test ./...`, which the repo-root `npm test` runs.
//
// whatsmeow is NOT imported. The two things that need it — sending a built
// message and decrypting a poll update — are the PollSender interface and the
// caller's own event handler. That keeps this module stdlib-only, so it builds
// on a host with no network, and keeps the fork's own diff to main.go small
// enough to rebase on every upstream re-pin.
package hzpoll

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
)

// The two option strings, byte-for-byte. These cross a process boundary: the
// bridge puts them in the PollCreationMessage, WhatsApp hashes them, and
// server/src/waSend.js matches the forwarded string against its own copy. A
// normalisation difference on either side is a 422 on every tap, so both sides
// pin them in a test (see poll_test.go and server/test/gate-notifier-poll.test.mjs).
const (
	OptionApprove  = "✅ Approve"    // white heavy check mark + space
	OptionSendBack = "↩️ Send back" // leftwards arrow with hook, emoji presentation
)

// Options is the poll as the human sees it, in order.
var Options = []string{OptionApprove, OptionSendBack}

// ErrNoSelection is returned when a poll update selected nothing. WhatsApp
// sends one of these when a voter DESELECTS their choice; it is not a vote and
// must not be guessed into one.
var ErrNoSelection = errors.New("poll update selected no option")

// ErrAmbiguousSelection is returned when more than one option hash came back.
// The poll is created with selectableOptionsCount = 1, so this should be
// impossible — which is exactly why it fails closed rather than picking the
// first. A guess here could approve a gate the human meant to send back.
var ErrAmbiguousSelection = errors.New("poll update selected more than one option")

// HashOptions mirrors whatsmeow.HashPollOptions. A vote carries SHA-256
// digests of the option NAMES, never the names themselves, so this is the only
// way back to a readable string.
//
// Duplicated rather than imported for the reason at the top of this file: one
// call to crypto/sha256 is a smaller cost than making this module depend on
// whatsmeow. testdata/probe/hz142_probe_test.go compiles against the real
// whatsmeow and asserts the two agree.
func HashOptions(names []string) [][]byte {
	out := make([][]byte, len(names))
	for i, name := range names {
		sum := sha256.Sum256([]byte(name))
		out[i] = sum[:]
	}
	return out
}

// ResolveSelected turns the hashes in a decrypted PollVoteMessage back into the
// one option string that was tapped.
//
// Fails closed on every ambiguity: no selection, several selections, or a hash
// matching none of `names`. The last case is what an option-string drift
// between this file and server/src/waSend.js would look like, and reporting it
// as an error beats forwarding a half-understood vote.
func ResolveSelected(hashes [][]byte, names []string) (string, error) {
	switch {
	case len(hashes) == 0:
		return "", ErrNoSelection
	case len(hashes) > 1:
		return "", ErrAmbiguousSelection
	}
	known := HashOptions(names)
	for i, h := range known {
		if bytes.Equal(h, hashes[0]) {
			return names[i], nil
		}
	}
	return "", fmt.Errorf("selected option hash matches none of the %d known options", len(names))
}
