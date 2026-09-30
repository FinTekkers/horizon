// HZ-142 Phase 0 probe. Runs INSIDE the pinned whatsapp-mcp bridge checkout
// (package main) so probe 3 calls the bridge's own real functions rather than
// a copy of them.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"runtime/debug"
	"testing"

	"go.mau.fi/whatsmeow"
	waProto "go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
)

// The exact strings server/src/waSend.js will send.
var options = []string{"✅ Approve", "↩️ Send back"}

func TestProbe0_pinnedVersions(t *testing.T) {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		t.Fatal("no build info")
	}
	for _, dep := range info.Deps {
		if dep.Path == "go.mau.fi/whatsmeow" {
			fmt.Printf("PROBE0 whatsmeow=%s\n", dep.Version)
		}
	}
	fmt.Printf("PROBE0 go=%s\n", info.GoVersion)
}

func TestProbe1_createPoll(t *testing.T) {
	var cli *whatsmeow.Client // BuildPollCreation touches no client state
	msg := cli.BuildPollCreation("HZ-142 — Review before execution", options, 1)
	pc := msg.GetPollCreationMessage()
	if pc == nil {
		t.Fatal("PROBE1 FAIL: no PollCreationMessage")
	}
	if len(pc.GetOptions()) != 2 {
		t.Fatalf("PROBE1 FAIL: %d options", len(pc.GetOptions()))
	}
	for i, o := range pc.GetOptions() {
		if o.GetOptionName() != options[i] {
			t.Fatalf("PROBE1 FAIL: option %d round-tripped as %q", i, o.GetOptionName())
		}
	}
	secret := msg.GetMessageContextInfo().GetMessageSecret()
	if len(secret) != 32 {
		t.Fatalf("PROBE1 FAIL: message secret is %d bytes, want 32", len(secret))
	}
	fmt.Printf("PROBE1 PASS name=%q options=%q selectable=%d secretBytes=%d\n",
		pc.GetName(), []string{pc.GetOptions()[0].GetOptionName(), pc.GetOptions()[1].GetOptionName()},
		pc.GetSelectableOptionsCount(), len(secret))
}

func TestProbe2_voteDecodesToAnOptionName(t *testing.T) {
	// DecryptPollVote exists with the signature the fork will call. Compile-time.
	var decrypt = (*whatsmeow.Client).DecryptPollVote
	_ = decrypt

	// The plaintext a decrypted vote yields is a PollVoteMessage of SHA-256
	// option hashes. This is that whole data path, minus the AES/HKDF layer,
	// which needs a live paired session.
	plaintext, err := proto.Marshal(&waProto.PollVoteMessage{
		SelectedOptions: whatsmeow.HashPollOptions(options[1:]),
	})
	if err != nil {
		t.Fatalf("PROBE2 FAIL: marshal: %v", err)
	}
	var got waProto.PollVoteMessage
	if err := proto.Unmarshal(plaintext, &got); err != nil {
		t.Fatalf("PROBE2 FAIL: unmarshal: %v", err)
	}
	if len(got.GetSelectedOptions()) != 1 {
		t.Fatalf("PROBE2 FAIL: %d selected", len(got.GetSelectedOptions()))
	}
	// Hash -> readable option string, which is what the fork forwards.
	var resolved string
	for _, h := range got.GetSelectedOptions() {
		for _, o := range options {
			sum := sha256.Sum256([]byte(o))
			if bytes.Equal(sum[:], h) {
				resolved = o
			}
		}
	}
	if resolved != options[1] {
		t.Fatalf("PROBE2 FAIL: resolved %q, want %q", resolved, options[1])
	}
	fmt.Printf("PROBE2 PASS selectedHash=%s resolvedOption=%q\n",
		hex.EncodeToString(got.GetSelectedOptions()[0]), resolved)
}

// Probe 3 (architecture review): does a poll create or a poll vote become a
// row in the bridge's `messages` table? farm/whatsapp/mcp_bridge.py's
// fetch_new() reads that table, so a row there is an LLM path.
func TestProbe3_pollMessagesAreNotStorableRows(t *testing.T) {
	var cli *whatsmeow.Client
	create := cli.BuildPollCreation("HZ-142 — Review before execution", options, 1)
	update := &waProto.Message{PollUpdateMessage: &waProto.PollUpdateMessage{
		Vote: &waProto.PollEncValue{EncPayload: []byte("ciphertext"), EncIV: []byte("iv")},
	}}

	for name, msg := range map[string]*waProto.Message{"PollCreationMessage": create, "PollUpdateMessage": update} {
		// The bridge's OWN functions — handleMessage stores a row only when at
		// least one of these is non-empty ("Skip if there's no content and no
		// media").
		content := extractTextContent(msg)
		mediaType, _, _, _, _, _, _ := extractMediaInfo(msg)
		if content != "" || mediaType != "" {
			t.Fatalf("PROBE3 FAIL: %s would be stored (content=%q mediaType=%q)", name, content, mediaType)
		}
		fmt.Printf("PROBE3 PASS %s content=%q mediaType=%q -> no messages row\n", name, content, mediaType)
	}
}
