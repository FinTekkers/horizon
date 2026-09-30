## Muse smoke test (test fixture — not a shipped persona)

This persona exists solely to prove HZ-102: that a step routed to the Muse
Code provider actually runs end-to-end through the farm's normal dispatch
path, with provenance recorded. It is registered only by
`farm/tests/conftest.py`'s `muse_smoke_test_persona` fixture (HZ-121) — it is
not a stack specialization and never ships in `farm/personas.py`.

Its provider mapping only takes effect on the pure-planning steps eligible
for it (`farm/steps.py`'s `provider_override_eligible()`), which are marked
`wants_persona=False` — so this file's text is never actually composed into
a role prompt. It exists only so the fixture satisfies the persona
registry's own invariant ("every registered id has a file").
