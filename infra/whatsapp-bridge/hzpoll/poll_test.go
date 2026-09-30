package hzpoll

import (
	"encoding/hex"
	"errors"
	"testing"
)

// The UTF-8 bytes of each option, pinned as hex rather than as a source
// literal. A literal would be asserted against itself and would survive an
// editor quietly dropping the variation selector (efb88f) out of "↩️" — which
// is exactly the drift that turns every tap into a 422, because
// server/src/waSend.js matches the forwarded string exactly.
// server/test/gate-notifier-poll.test.mjs pins the same two sequences.
const (
	approveHex  = "e29c8520417070726f7665"
	sendBackHex = "e286a9efb88f2053656e64206261636b"
)

func TestOptionStringsArePinnedByteForByte(t *testing.T) {
	if got := hex.EncodeToString([]byte(OptionApprove)); got != approveHex {
		t.Fatalf("OptionApprove is %s, want %s", got, approveHex)
	}
	if got := hex.EncodeToString([]byte(OptionSendBack)); got != sendBackHex {
		t.Fatalf("OptionSendBack is %s, want %s", got, sendBackHex)
	}
	if len(Options) != 2 || Options[0] != OptionApprove || Options[1] != OptionSendBack {
		t.Fatalf("Options is %q — approve must be first and there must be exactly two", Options)
	}
}

// whatsmeow.HashPollOptions is plain SHA-256 over the option name, so these
// two digests are what WhatsApp actually puts in a vote. Both were produced by
// the real whatsmeow build in the Phase 0 probe — see PROBE.md.
func TestHashOptionsMatchesTheDigestsWhatsmeowProduces(t *testing.T) {
	for _, c := range []struct{ option, digest string }{
		{OptionApprove, "478e7efeac9f1417082bcbd8ce1f6b794005302571318226295be1ceb4c5087b"},
		{OptionSendBack, "b1fb54f6a94dcf29e1d8069e4642fb6ab10fc2c5166baad7376047feb4ec4906"},
	} {
		if got := hex.EncodeToString(HashOptions([]string{c.option})[0]); got != c.digest {
			t.Fatalf("hash of %q is %s, want %s", c.option, got, c.digest)
		}
	}
}

func TestResolveSelectedReturnsTheTappedOption(t *testing.T) {
	for _, want := range Options {
		got, err := ResolveSelected(HashOptions([]string{want}), Options)
		if err != nil {
			t.Fatalf("%q: %v", want, err)
		}
		if got != want {
			t.Fatalf("resolved %q, want %q", got, want)
		}
	}
}

// Every case here is one where guessing could approve a gate the human meant
// to send back. All four must be errors, never a best-effort answer.
func TestResolveSelectedFailsClosed(t *testing.T) {
	t.Run("a deselection sends no hashes", func(t *testing.T) {
		if _, err := ResolveSelected(nil, Options); !errors.Is(err, ErrNoSelection) {
			t.Fatalf("got %v, want ErrNoSelection", err)
		}
	})
	t.Run("two hashes is ambiguous", func(t *testing.T) {
		if _, err := ResolveSelected(HashOptions(Options), Options); !errors.Is(err, ErrAmbiguousSelection) {
			t.Fatalf("got %v, want ErrAmbiguousSelection", err)
		}
	})
	t.Run("an unknown hash is not resolved to the nearest option", func(t *testing.T) {
		if got, err := ResolveSelected(HashOptions([]string{"Approve"}), Options); err == nil {
			t.Fatalf("a plain-text 'Approve' resolved to %q — option drift would go unnoticed", got)
		}
	})
	t.Run("a truncated hash does not match by prefix", func(t *testing.T) {
		short := HashOptions([]string{OptionApprove})[0][:16]
		if _, err := ResolveSelected([][]byte{short}, Options); err == nil {
			t.Fatal("a 16-byte prefix matched a 32-byte hash")
		}
	})
}
