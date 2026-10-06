# FinTekkers/ledger-service — repo rules

## Tech stack

Java 17, Gradle (`./gradlew`), gRPC. The server is the `subledger` module
(`service.Service`); `persistence-utils` and `node-utils` are libraries.

## Build & test

- `scripts/checks/test.sh` is the check Horizon runs (main's copy): it runs
  `./gradlew :subledger:test` against the `ledger_test` database. Run it
  before pushing.
- Integration tests tagged `integration` need valuation-service and are
  excluded by default (`:subledger:integrationTest`).

## ledger-models dependency

- The models come from `io.github.fintekkers:ledger-models`, pinned in
  `subledger/build.gradle`. Read that version's source (tag `vX.Y.Z` in
  FinTekkers/ledger-models), not main, when tracing a bug into
  `common.models.*` or `protos.serializers.*`.
- Most NPEs and UNKNOWN status codes that surface here start in the models
  jar (`ProtoSerializationUtil`, `Transaction`, `Security`, serializers).
  Apply the project rules' "Models first" section before planning a fix
  here.
- After a ledger-models release, picking it up is a one-line version bump
  in `subledger/build.gradle`, plus whatever the release changed. Remove any
  local workaround the release makes unnecessary.

## Constraints

- `ValidateCreateOrUpdate` RPCs return OK with errors inside a
  `SummaryProto`; `CreateOrUpdate` returns gRPC status codes. Don't change
  one contract into the other without a ledger-models change that says so.
- Map input errors to INVALID_ARGUMENT, missing objects to NOT_FOUND and
  state conflicts (e.g. no tax lots to reduce) to FAILED_PRECONDITION or
  ABORTED. Never let an NPE surface as UNKNOWN.
