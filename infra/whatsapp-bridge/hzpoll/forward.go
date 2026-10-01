package hzpoll

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// VoteHeader is the credential header the Horizon server checks on
// POST /api/wa/poll-vote. It is the SAME dedicated approval credential the
// concierge already holds (WA_APPROVAL_SECRET) — never FARM_SHARED_SECRET,
// which every agent session used to inherit and which HZ-140 removed from this
// path on purpose.
const VoteHeader = "X-WA-Approval-Secret"

// ErrNoCredential is returned at construction rather than at the first vote. A
// forwarder with no secret would post an unauthenticated vote, collect a 401,
// treat it as final, and drop the tap silently.
var ErrNoCredential = errors.New("hzpoll: no approval secret configured — refusing to forward votes")

// Forwarder commits each vote and then posts it to the Horizon server.
type Forwarder struct {
	Store    VoteStore
	Endpoint string // HORIZON_VOTE_URL, e.g. http://127.0.0.1:3001/api/wa/poll-vote
	Secret   string // WA_APPROVAL_SECRET
	Client   *http.Client
	// MaxAttempts bounds the retry of a server that is down. Zero means 6.
	MaxAttempts int
	// Sleep is the backoff, injectable so the tests do not actually wait.
	Sleep func(time.Duration)
	Log   func(format string, args ...any)
}

func (f *Forwarder) sleep(d time.Duration) {
	if f.Sleep != nil {
		f.Sleep(d)
		return
	}
	time.Sleep(d)
}

func (f *Forwarder) log(format string, args ...any) {
	if f.Log != nil {
		f.Log(format, args...)
	}
}

func (f *Forwarder) maxAttempts() int {
	if f.MaxAttempts > 0 {
		return f.MaxAttempts
	}
	return 6
}

func (f *Forwarder) client() *http.Client {
	if f.Client != nil {
		return f.Client
	}
	return &http.Client{Timeout: 15 * time.Second}
}

// Validate is what main.go calls at boot, so a misconfigured forwarder is a
// startup failure rather than a vote that vanishes at 3am.
func (f *Forwarder) Validate() error {
	if f.Secret == "" {
		return ErrNoCredential
	}
	if f.Endpoint == "" {
		return errors.New("hzpoll: no vote endpoint configured")
	}
	if f.Store == nil {
		return errors.New("hzpoll: no vote store configured")
	}
	return nil
}

// Handle commits one decrypted vote and forwards it.
//
// COMMIT FIRST, POST SECOND, always. Save() returning isNew=false means this
// exact poll update has already been seen, so it is dropped here — a
// re-delivery never becomes a second POST.
func (f *Forwarder) Handle(v Vote) error {
	isNew, err := f.Store.Save(v)
	if err != nil {
		return fmt.Errorf("could not commit vote %s: %w", v.VoteID, err)
	}
	if !isNew {
		f.log("hzpoll: vote %s already seen — not forwarded again", v.VoteID)
		return nil
	}
	return f.forward(v)
}

// ReplayPending re-posts every vote committed but never forwarded — the other
// half of commit-before-POST. Called once at boot, so a tap that landed while
// the Horizon server was restarting still decides its gate.
func (f *Forwarder) ReplayPending() (int, error) {
	pending, err := f.Store.Pending()
	if err != nil {
		return 0, err
	}
	replayed := 0
	for _, v := range pending {
		if err := f.forward(v); err != nil {
			f.log("hzpoll: replay of vote %s failed: %v", v.VoteID, err)
			continue
		}
		replayed++
	}
	return replayed, nil
}

func (f *Forwarder) forward(v Vote) error {
	var lastErr error
	for attempt := 1; attempt <= f.maxAttempts(); attempt++ {
		final, err := f.post(v)
		if err == nil {
			return f.Store.MarkForwarded(v.VoteID)
		}
		lastErr = err
		if final {
			// A 4xx is the server's considered refusal: a wrong credential, a
			// voter who is not an approver, an unknown poll. Retrying it
			// forever would hammer the server over one unauthorised tap and
			// would never change the answer. Record it as handled and move on
			// — loudly, because a 401 here is silent on the human's phone.
			f.log("hzpoll: vote %s finally refused by the server: %v", v.VoteID, err)
			return f.Store.MarkForwarded(v.VoteID)
		}
		if attempt < f.maxAttempts() {
			// 1s doubling, capped at a minute.
			delay := time.Duration(1<<(attempt-1)) * time.Second
			if delay > time.Minute {
				delay = time.Minute
			}
			f.sleep(delay)
		}
	}
	// Left unmarked ON PURPOSE: the vote stays pending, so the next boot's
	// ReplayPending picks it up. That is the durability the commit bought.
	return fmt.Errorf("vote %s not forwarded after %d attempt(s): %w", v.VoteID, f.maxAttempts(), lastErr)
}

// post returns (final, err). final=true means "never retry this".
func (f *Forwarder) post(v Vote) (bool, error) {
	body, err := json.Marshal(map[string]string{
		"voteId":         v.VoteID,
		"pollMessageId":  v.PollMsgID,
		"voterJid":       v.VoterJID,
		"selectedOption": v.Option,
	})
	if err != nil {
		return true, err // an unmarshalable vote will not become marshalable
	}
	req, err := http.NewRequest(http.MethodPost, f.Endpoint, bytes.NewReader(body))
	if err != nil {
		return true, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(VoteHeader, f.Secret)

	res, err := f.client().Do(req)
	if err != nil {
		return false, err // network failure — retry
	}
	defer res.Body.Close()
	detail, _ := io.ReadAll(io.LimitReader(res.Body, 512))
	switch {
	case res.StatusCode >= 200 && res.StatusCode < 300:
		return false, nil
	case res.StatusCode >= 400 && res.StatusCode < 500:
		return true, fmt.Errorf("server answered %d: %s", res.StatusCode, detail)
	default:
		return false, fmt.Errorf("server answered %d: %s", res.StatusCode, detail)
	}
}
