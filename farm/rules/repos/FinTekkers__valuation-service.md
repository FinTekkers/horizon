# FinTekkers/valuation-service — repo rules

## Build & test

- `scripts/checks/test.sh` is the check Horizon runs (main's copy). It
  puts `~/.cargo/bin` on PATH and turns off debug info and incremental
  builds to keep `target/` small. Run it before pushing.

## ledger-models dependency

- The `ledger-models` crate is pinned in `Cargo.toml`. Read that
  version's source (tag `vX.Y.Z` in FinTekkers/ledger-models), not main,
  when tracing a bug into the models.
- Apply the project rules' "Models first" section before working around a
  model or proto problem here. Picking up a ledger-models release is a
  version bump in `Cargo.toml` plus whatever the release changed.
