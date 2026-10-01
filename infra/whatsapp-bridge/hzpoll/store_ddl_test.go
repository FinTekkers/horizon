package hzpoll

import (
	"regexp"
	"testing"
)

// SQLite rejects rowid in an index's column list ("no such column: rowid"):
// every index already carries the rowid implicitly. This package is
// stdlib-only and its tests use a fake VoteStore, so the real DDL never ran
// against SQLite until the bridge's boot-time Migrate() failed in production
// (2026-10-01). Pin the shape instead.
func TestVoteTableDDLIndexesNeverNameRowid(t *testing.T) {
	re := regexp.MustCompile(`(?is)CREATE\s+INDEX[^;]*\(([^)]*)\)`)
	for _, m := range re.FindAllStringSubmatch(VoteTableDDL, -1) {
		if regexp.MustCompile(`(?i)\browid\b`).MatchString(m[1]) {
			t.Fatalf("index column list %q names rowid; SQLite rejects that at Migrate()", m[1])
		}
	}
}
