package hzpoll

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// Records the ORDER of store and network calls, which is the only way to
// assert commit-before-POST rather than assume it.
type fakeStore struct {
	mu        sync.Mutex
	saved     []Vote
	forwarded []string
	trace     *[]string
	saveErr   error
	dupes     map[string]bool
}

func newFakeStore(trace *[]string) *fakeStore {
	return &fakeStore{trace: trace, dupes: map[string]bool{}}
}

func (s *fakeStore) note(what string) {
	if s.trace != nil {
		*s.trace = append(*s.trace, what)
	}
}

func (s *fakeStore) Save(v Vote) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.note("save:" + v.VoteID)
	if s.saveErr != nil {
		return false, s.saveErr
	}
	if s.dupes[v.VoteID] {
		return false, nil
	}
	s.dupes[v.VoteID] = true
	s.saved = append(s.saved, v)
	return true, nil
}

func (s *fakeStore) MarkForwarded(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.note("mark:" + id)
	s.forwarded = append(s.forwarded, id)
	return nil
}

func (s *fakeStore) Pending() ([]Vote, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Vote
	for _, v := range s.saved {
		done := false
		for _, id := range s.forwarded {
			if id == v.VoteID {
				done = true
			}
		}
		if !done {
			out = append(out, v)
		}
	}
	return out, nil
}

type capture struct {
	bodies  []map[string]string
	headers []http.Header
}

// serverReturning answers each request with the next status in `statuses`,
// repeating the last one once exhausted.
func serverReturning(t *testing.T, cap *capture, trace *[]string, statuses ...int) *httptest.Server {
	t.Helper()
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]string
		_ = json.Unmarshal(raw, &body)
		cap.bodies = append(cap.bodies, body)
		cap.headers = append(cap.headers, r.Header.Clone())
		if trace != nil {
			*trace = append(*trace, "post:"+body["voteId"])
		}
		status := statuses[len(statuses)-1]
		if n < len(statuses) {
			status = statuses[n]
		}
		n++
		w.WriteHeader(status)
		w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newForwarder(store VoteStore, endpoint string) *Forwarder {
	return &Forwarder{
		Store:       store,
		Endpoint:    endpoint,
		Secret:      "wa-approval-secret-for-tests",
		MaxAttempts: 4,
		Sleep:       func(time.Duration) {}, // no real waiting in tests
		Log:         func(string, ...any) {},
	}
}

const testVoteID = "3EB0VOTE1"

func aVote() Vote {
	return Vote{VoteID: testVoteID, PollMsgID: "3EB0POLL1", VoterJID: "15550003333@s.whatsapp.net", Option: OptionApprove}
}

// THE durability assertion. A tap that lands while the Horizon server is
// restarting must survive, which it only does if the row is committed before
// the request leaves.
func TestTheVoteIsCommittedBeforeItIsPosted(t *testing.T) {
	var trace []string
	store := newFakeStore(&trace)
	srv := serverReturning(t, &capture{}, &trace, 200)

	if err := newForwarder(store, srv.URL).Handle(aVote()); err != nil {
		t.Fatal(err)
	}
	want := []string{"save:" + testVoteID, "post:" + testVoteID, "mark:" + testVoteID}
	if strings.Join(trace, ",") != strings.Join(want, ",") {
		t.Fatalf("call order was %v, want %v", trace, want)
	}
}

func TestAFailedCommitIsNeverPosted(t *testing.T) {
	var trace []string
	store := newFakeStore(&trace)
	store.saveErr = errors.New("disk full")
	srv := serverReturning(t, &capture{}, &trace, 200)

	if err := newForwarder(store, srv.URL).Handle(aVote()); err == nil {
		t.Fatal("a vote that could not be committed was reported as handled")
	}
	for _, step := range trace {
		if strings.HasPrefix(step, "post:") {
			t.Fatalf("an uncommitted vote was posted: %v", trace)
		}
	}
}

// The bridge re-delivers; WhatsApp re-delivers. An overlap is the normal case.
func TestTheSameVoteDeliveredTwicePostsOnce(t *testing.T) {
	cap := &capture{}
	store := newFakeStore(nil)
	srv := serverReturning(t, cap, nil, 200)
	f := newForwarder(store, srv.URL)

	for i := 0; i < 3; i++ {
		if err := f.Handle(aVote()); err != nil {
			t.Fatal(err)
		}
	}
	if len(cap.bodies) != 1 {
		t.Fatalf("posted %d times, want 1", len(cap.bodies))
	}
}

func TestTheDedicatedCredentialIsSentAndFarmSharedSecretIsNot(t *testing.T) {
	cap := &capture{}
	srv := serverReturning(t, cap, nil, 200)
	if err := newForwarder(newFakeStore(nil), srv.URL).Handle(aVote()); err != nil {
		t.Fatal(err)
	}
	h := cap.headers[0]
	if h.Get(VoteHeader) != "wa-approval-secret-for-tests" {
		t.Fatalf("approval header is %q", h.Get(VoteHeader))
	}
	// The forgery HZ-140 closed: FARM_SHARED_SECRET reached every agent
	// session. It must not appear on this path in any form.
	for name := range h {
		if strings.Contains(strings.ToLower(name), "farm") {
			t.Fatalf("a farm credential header rode along: %s", name)
		}
	}
	if h.Get("Authorization") != "" {
		t.Fatalf("an Authorization header was sent: %q", h.Get("Authorization"))
	}
	body := cap.bodies[0]
	for k, v := range body {
		if strings.Contains(strings.ToLower(v), "secret") {
			t.Fatalf("the body field %q carries a credential-shaped value", k)
		}
	}
	want := map[string]string{
		"voteId": testVoteID, "pollMessageId": "3EB0POLL1",
		"voterJid": "15550003333@s.whatsapp.net", "selectedOption": OptionApprove,
	}
	if len(body) != len(want) {
		t.Fatalf("body has %d fields: %v", len(body), body)
	}
	for k, v := range want {
		if body[k] != v {
			t.Fatalf("body[%s] = %q, want %q", k, body[k], v)
		}
	}
}

// A 4xx is the server's considered refusal — a wrong credential, a voter who
// is not an approver. Retrying it forever hammers the server over one
// unauthorised tap and can never change the answer.
func TestA4xxIsFinalAndNeverRetried(t *testing.T) {
	for _, status := range []int{400, 401, 403, 404, 409, 422} {
		cap := &capture{}
		store := newFakeStore(nil)
		srv := serverReturning(t, cap, nil, status)
		if err := newForwarder(store, srv.URL).Handle(aVote()); err != nil {
			t.Fatalf("%d: %v", status, err)
		}
		if len(cap.bodies) != 1 {
			t.Fatalf("%d was retried %d time(s)", status, len(cap.bodies)-1)
		}
		if len(store.forwarded) != 1 {
			t.Fatalf("%d left the vote pending — it would replay on every boot", status)
		}
	}
}

func TestA5xxIsRetriedAndThenSucceeds(t *testing.T) {
	cap := &capture{}
	store := newFakeStore(nil)
	srv := serverReturning(t, cap, nil, 500, 503, 200)
	if err := newForwarder(store, srv.URL).Handle(aVote()); err != nil {
		t.Fatal(err)
	}
	if len(cap.bodies) != 3 {
		t.Fatalf("made %d attempt(s), want 3", len(cap.bodies))
	}
	if len(store.forwarded) != 1 {
		t.Fatal("the vote was never marked forwarded")
	}
}

// The other half of commit-before-POST: a server that never comes back leaves
// the row pending, and the next boot replays it.
func TestAVoteTheServerNeverAcceptsStaysPendingAndReplays(t *testing.T) {
	cap := &capture{}
	store := newFakeStore(nil)
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	f := newForwarder(store, down.URL)
	if err := f.Handle(aVote()); err == nil {
		t.Fatal("a vote the server never accepted was reported as forwarded")
	}
	if len(store.forwarded) != 0 {
		t.Fatal("the vote was marked forwarded despite never being accepted")
	}
	pending, _ := store.Pending()
	if len(pending) != 1 {
		t.Fatalf("%d pending vote(s), want 1", len(pending))
	}
	down.Close()

	// The server comes back. This is the restart case the commit exists for.
	up := serverReturning(t, cap, nil, 200)
	f.Endpoint = up.URL
	replayed, err := f.ReplayPending()
	if err != nil {
		t.Fatal(err)
	}
	if replayed != 1 {
		t.Fatalf("replayed %d, want 1", replayed)
	}
	if got := cap.bodies[0]["voteId"]; got != testVoteID {
		t.Fatalf("replayed the wrong vote: %q", got)
	}
	if rest, _ := store.Pending(); len(rest) != 0 {
		t.Fatalf("%d vote(s) still pending after a successful replay", len(rest))
	}
}

// A forwarder with no credential would post unauthenticated, collect a 401,
// treat it as final and drop every tap in silence.
func TestValidateRefusesAMisconfiguredForwarder(t *testing.T) {
	base := func() *Forwarder { return newForwarder(newFakeStore(nil), "http://127.0.0.1:1") }
	if err := base().Validate(); err != nil {
		t.Fatalf("a complete forwarder was rejected: %v", err)
	}
	noSecret := base()
	noSecret.Secret = ""
	if err := noSecret.Validate(); !errors.Is(err, ErrNoCredential) {
		t.Fatalf("got %v, want ErrNoCredential", err)
	}
	noEndpoint := base()
	noEndpoint.Endpoint = ""
	if noEndpoint.Validate() == nil {
		t.Fatal("a forwarder with no endpoint was accepted")
	}
	noStore := base()
	noStore.Store = nil
	if noStore.Validate() == nil {
		t.Fatal("a forwarder with no store was accepted")
	}
}
