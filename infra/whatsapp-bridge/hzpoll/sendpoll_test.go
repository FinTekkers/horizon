package hzpoll

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeSender struct {
	calls  []SendPollRequest
	msgID  string
	err    error
	stored []string // what this sender would have written to the `messages` table
}

func (s *fakeSender) SendPoll(recipient, name string, options []string) (string, error) {
	s.calls = append(s.calls, SendPollRequest{Recipient: recipient, Name: name, Options: options})
	return s.msgID, s.err
}

func post(t *testing.T, h http.HandlerFunc, body string) (*http.Response, SendPollResponse, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/send-poll", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h(rec, req)
	res := rec.Result()
	var parsed SendPollResponse
	raw := rec.Body.String()
	_ = json.Unmarshal([]byte(raw), &parsed)
	return res, parsed, raw
}

const goodBody = `{"recipient":"15550003333@s.whatsapp.net","name":"HZ-142 — Review before execution","options":["✅ Approve","↩️ Send back"]}`

func TestSendPollReturnsTheMessageId(t *testing.T) {
	sender := &fakeSender{msgID: "3EB0F1E2D3A4B5"}
	res, body, _ := post(t, SendPollHandler(sender), goodBody)
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	if !body.Success || body.MessageID != "3EB0F1E2D3A4B5" {
		t.Fatalf("body was %+v", body)
	}
	if len(sender.calls) != 1 {
		t.Fatalf("%d send(s)", len(sender.calls))
	}
	call := sender.calls[0]
	if call.Recipient != "15550003333@s.whatsapp.net" || call.Name != "HZ-142 — Review before execution" {
		t.Fatalf("call was %+v", call)
	}
	if len(call.Options) != 2 || call.Options[0] != OptionApprove || call.Options[1] != OptionSendBack {
		t.Fatalf("options arrived as %q — the emoji did not survive the JSON boundary", call.Options)
	}
}

// A poll whose id the server never learns is a tappable orphan: the human
// votes and nothing at all happens. waSend.js retries on a missing id, so this
// must be a failure and not a cheerful 200.
func TestA200WithNoMessageIdIsAFailure(t *testing.T) {
	res, body, _ := post(t, SendPollHandler(&fakeSender{msgID: ""}), goodBody)
	if res.StatusCode != 500 {
		t.Fatalf("status %d, want 500", res.StatusCode)
	}
	if body.Success {
		t.Fatal("success:true with no message id")
	}
	if !strings.Contains(body.Message, "message id") {
		t.Fatalf("the reason is not stated: %q", body.Message)
	}
}

func TestASendFailureIs500WithTheReason(t *testing.T) {
	res, body, _ := post(t, SendPollHandler(&fakeSender{err: errors.New("Not connected to WhatsApp")}), goodBody)
	if res.StatusCode != 500 || body.Success {
		t.Fatalf("status %d body %+v", res.StatusCode, body)
	}
	if body.Message != "Not connected to WhatsApp" {
		t.Fatalf("message was %q", body.Message)
	}
}

func TestMalformedRequestsAre400AndSendNothing(t *testing.T) {
	cases := map[string]string{
		"not json":       `{`,
		"no recipient":   `{"name":"x","options":["a","b"]}`,
		"no name":        `{"recipient":"r","options":["a","b"]}`,
		"no options":     `{"recipient":"r","name":"x"}`,
		"one option":     `{"recipient":"r","name":"x","options":["a"]}`,
		"empty options":  `{"recipient":"r","name":"x","options":[]}`,
		"null recipient": `{"recipient":"","name":"x","options":["a","b"]}`,
	}
	for name, body := range cases {
		sender := &fakeSender{msgID: "X"}
		res, _, _ := post(t, SendPollHandler(sender), body)
		if res.StatusCode != 400 {
			t.Fatalf("%s: status %d, want 400", name, res.StatusCode)
		}
		if len(sender.calls) != 0 {
			t.Fatalf("%s: a malformed request still sent a poll", name)
		}
	}
}

func TestOnlyPostIsAllowed(t *testing.T) {
	sender := &fakeSender{msgID: "X"}
	h := SendPollHandler(sender)
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest(method, "/api/send-poll", nil))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s got %d", method, rec.Code)
		}
	}
	if len(sender.calls) != 0 {
		t.Fatal("a non-POST sent a poll")
	}
}

// /api/send takes no auth because the bridge is loopback-only, and this
// sibling must not quietly become the one endpoint that does — a credential
// here would be a second place WA_APPROVAL_SECRET has to be kept in step.
func TestSendPollTakesNoCredential(t *testing.T) {
	sender := &fakeSender{msgID: "3EB0"}
	req := httptest.NewRequest(http.MethodPost, "/api/send-poll", strings.NewReader(goodBody))
	req.Header.Set(VoteHeader, "should-be-ignored")
	rec := httptest.NewRecorder()
	SendPollHandler(sender)(rec, req)
	if rec.Code != 200 {
		t.Fatalf("a request without the header would have to succeed too; got %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "should-be-ignored") {
		t.Fatal("the handler echoed a header value back")
	}
}

// The forwarder and the send path both live outside the bridge's `messages`
// table, which farm/whatsapp/mcp_bridge.py's fetch_new() reads and hands to
// the concierge (a model call). This pins the store the votes go to instead.
func TestVotesAreStoredInTheirOwnTableNeverMessages(t *testing.T) {
	if strings.Contains(VoteTableDDL, "messages") {
		t.Fatal("the vote DDL touches the messages table — every tap would reach the concierge")
	}
	if !strings.Contains(VoteTableDDL, "poll_votes") {
		t.Fatal("the vote DDL does not create poll_votes")
	}
	if !strings.Contains(VoteTableDDL, "vote_id      TEXT PRIMARY KEY") {
		t.Fatal("vote_id is not the primary key — duplicate delivery would not be caught")
	}
}
