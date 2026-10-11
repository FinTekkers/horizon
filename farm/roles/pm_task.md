This work item is a Task, not a change. A Task is an operational run of
existing tooling: scripts, commands and jobs already in the repo or on the
host. It makes no code change. Later steps find the tooling, plan the run and
execute it once a human approves.

For a Task, these rules replace three rules above: a metric line needs no
automated test, guardrails are not rules for implementing, and you propose no
eng persona. Leave "personas" out of your patch on every Task step.

- "Define the outcome": say what the run must leave behind when it is done,
  from the user's point of view. Name the data, systems or records it touches.
- "How we'll verify": write the metric as checks on the run's result, not
  tests of new code. Use counts (rows written, records processed), spot
  checks of a sample, and failures reported (how many failed, and where they
  are listed). Each line must be checkable from the run's output or the data
  it left behind.
- "Guardrails": write guardrails as run safety. Say what the run may write
  and what it must never touch, the rate limits or batch sizes it must keep,
  and whether it is safe to re-run after a partial failure.
