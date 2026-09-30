package hzpoll

import (
	"encoding/json"
	"net/http"
)

// PollSender is the whatsmeow half, kept behind an interface so this module
// never imports it. The fork's implementation is three lines:
//
//	msg := client.BuildPollCreation(name, options, 1)
//	resp, err := client.SendMessage(ctx, recipientJID, msg)
//	return resp.ID, err
type PollSender interface {
	SendPoll(recipient, name string, options []string) (msgID string, err error)
}

// SendPollRequest is what server/src/waSend.js posts.
type SendPollRequest struct {
	Recipient string   `json:"recipient"`
	Name      string   `json:"name"`
	Options   []string `json:"options"`
}

// SendPollResponse mirrors the upstream /api/send shape, plus the message id.
//
// messageId is not optional in practice: a poll whose id the server never
// learns is a tappable orphan — the human votes and nothing happens, with no
// error anywhere. waSend.js treats a 200 with no messageId as a failure and
// retries, so this handler must never answer success without one.
type SendPollResponse struct {
	Success   bool   `json:"success"`
	Message   string `json:"message"`
	MessageID string `json:"messageId,omitempty"`
}

// SendPollHandler serves POST /api/send-poll, the sibling of the upstream
// POST /api/send. Like /api/send it takes NO auth: the bridge listens on
// loopback only, and this path holds no credential to offer.
func SendPollHandler(sender PollSender) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req SendPollRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid request format", http.StatusBadRequest)
			return
		}
		if req.Recipient == "" {
			http.Error(w, "Recipient is required", http.StatusBadRequest)
			return
		}
		if req.Name == "" {
			http.Error(w, "Name is required", http.StatusBadRequest)
			return
		}
		// Two or more, because a one-option poll is not a choice and WhatsApp
		// renders it as an oddity rather than refusing it.
		if len(req.Options) < 2 {
			http.Error(w, "At least two options are required", http.StatusBadRequest)
			return
		}

		msgID, err := sender.SendPoll(req.Recipient, req.Name, req.Options)
		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(SendPollResponse{Success: false, Message: err.Error()})
			return
		}
		if msgID == "" {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(SendPollResponse{
				Success: false,
				Message: "poll was sent but WhatsApp returned no message id — it could not be tracked",
			})
			return
		}
		json.NewEncoder(w).Encode(SendPollResponse{Success: true, Message: "poll sent", MessageID: msgID})
	}
}
