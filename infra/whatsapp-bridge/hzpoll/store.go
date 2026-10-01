package hzpoll

import (
	"database/sql"
	"errors"
)

// Vote is one tap, after decryption and after the option hash has been
// resolved back to a readable string.
type Vote struct {
	// VoteID is the poll-update message id. It is the idempotence key on BOTH
	// sides: the primary key of poll_votes here, and of gate_poll_vote in the
	// Horizon server's schema.
	VoteID string
	// PollMsgID is the id of the poll-creation message this vote is about —
	// what the server looks the gate up by.
	PollMsgID string
	VoterJID  string
	Option    string
}

// VoteStore is the durable side of commit-before-POST.
//
// The ordering is the whole point. A vote that arrives while the Horizon
// server is restarting has to survive, so it is committed here first and
// posted second; a process death between the two leaves a Pending() row that
// the next boot replays. Without this a tap during a deploy is simply lost and
// the human is left staring at a poll that did nothing.
type VoteStore interface {
	// Save commits the vote. Returns false when VoteID was already stored,
	// which is how a re-delivery of the same poll update is dropped before it
	// reaches the network.
	Save(v Vote) (isNew bool, err error)
	// MarkForwarded records that the server accepted (or finally refused) the
	// vote, so it is not replayed on the next boot.
	MarkForwarded(voteID string) error
	// Pending returns every committed-but-not-forwarded vote, oldest first.
	Pending() ([]Vote, error)
}

// VoteTableDDL is the fork's own table. Deliberately NOT the `messages` table:
// farm/whatsapp/mcp_bridge.py's fetch_new() reads every new `messages` rowid
// and hands it to the concierge, which is a model call. A vote written there
// would reach run_agent and reproduce the exact false-approval bug HZ-142
// exists to remove. Votes live here, which fetch_new never reads.
const VoteTableDDL = `
CREATE TABLE IF NOT EXISTS poll_votes (
    vote_id      TEXT PRIMARY KEY,
    poll_msg_id  TEXT NOT NULL,
    voter_jid    TEXT NOT NULL,
    option_name  TEXT NOT NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    forwarded_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_poll_votes_pending ON poll_votes(forwarded_at, rowid);
`

// SQLVoteStore is VoteStore over database/sql. The driver is registered by the
// fork's main.go (mattn/go-sqlite3, already its dependency), so this file
// imports no driver and the module stays stdlib-only.
type SQLVoteStore struct{ DB *sql.DB }

// Migrate creates the table. Safe to call on every boot.
func (s *SQLVoteStore) Migrate() error {
	if s.DB == nil {
		return errors.New("hzpoll: SQLVoteStore has no DB")
	}
	_, err := s.DB.Exec(VoteTableDDL)
	return err
}

func (s *SQLVoteStore) Save(v Vote) (bool, error) {
	// INSERT OR IGNORE plus RowsAffected is the duplicate check — the primary
	// key collision IS the answer, so there is no read-then-write race.
	res, err := s.DB.Exec(
		"INSERT OR IGNORE INTO poll_votes (vote_id, poll_msg_id, voter_jid, option_name) VALUES (?, ?, ?, ?)",
		v.VoteID, v.PollMsgID, v.VoterJID, v.Option,
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

func (s *SQLVoteStore) MarkForwarded(voteID string) error {
	_, err := s.DB.Exec("UPDATE poll_votes SET forwarded_at = CURRENT_TIMESTAMP WHERE vote_id = ?", voteID)
	return err
}

func (s *SQLVoteStore) Pending() ([]Vote, error) {
	rows, err := s.DB.Query(
		"SELECT vote_id, poll_msg_id, voter_jid, option_name FROM poll_votes WHERE forwarded_at IS NULL ORDER BY rowid",
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Vote
	for rows.Next() {
		var v Vote
		if err := rows.Scan(&v.VoteID, &v.PollMsgID, &v.VoterJID, &v.Option); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
