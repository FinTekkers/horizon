## Muse smoke test (test-only — not a real specialization)

This persona exists solely to prove HZ-102: that a step routed to the Muse
Code provider actually runs end-to-end through the farm's normal dispatch
path, with provenance recorded. It is not a stack specialization, is never
offered in the UI's persona picker, and must never be applied to a real
deliverable — only to a throwaway, clearly-labelled test work item.

Its provider mapping (`farm/personas.py`'s `PERSONA_PROVIDERS`) only takes
effect on the pure-planning steps eligible for it
(`farm/step_agent.py`'s `PROVIDER_OVERRIDE_ELIGIBLE_STEPS`), which are marked
`wants_persona=False` — so this file's text is never actually composed into
a role prompt. It exists only so the persona registry's own invariant
("every registered id has a file") holds.
