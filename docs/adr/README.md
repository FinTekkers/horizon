# Architecture decision records

An architecture decision record (ADR) writes down one significant Horizon design decision: the
context, what was decided, what follows from it, and what else was considered.

## Numbering

- Numbers have four digits and start at `0001`.
- A new ADR takes the next unused number. Numbers are never reused or renumbered.
- The file name is `NNNN-short-slug.md`, for example `0001-agent-asks.md`.

## Statuses

- **Proposed:** open for owner review. The text can still change.
- **Accepted:** approved by the owner. After this only the status line may change. A fix or a
  change of mind goes through a new ADR that supersedes this one.
- **Superseded by ADR NNNN:** replaced. The old ADR's status line becomes
  `Superseded by [ADR NNNN](NNNN-short-slug.md)`, linking forward to the new ADR, and the new ADR's
  Context links back to the one it replaces.

When an ADR's status changes, update its row in the index below.

## Template

```markdown
# ADR NNNN: Title

- **Status:** Proposed
- **Deciders:** the owner
- **Plan:** the Plan item that links this ADR

## Context

What problem this decides, and the evidence for it.

## Decision

What Horizon will do.

## Consequences

What changes as a result, good and bad.

## Alternatives considered

- **Option.** Why it was rejected.

## Documentation changes

Optional. The docs that change when the decision is built.

| File | Change |
|---|---|
| `docs/example.md` | What changes |
```

## Index

`Proposed` is the date the ADR was first proposed, not the date it was accepted.

| ADR | Title | Status | Proposed |
|---|---|---|---|
| 0001 | [Asks — follow-up and prerequisite work that agents raise](0001-agent-asks.md) | Accepted | 3 Nov 2026 |
