## Recommendation
**SEND BACK**. Option A is sound, but two **blocking** architect findings are unresolved and gate 15 has no real data source today.

## Test contract
The binding test list for implement and review. One bullet per kept case:
- **Kept:** rule precedence (R13). `operator must decide` beats approve. A running pre-merge beats resolve conflicts — verifies metric line 5
- **Kept:** off project with items at every gate gives 0 rows and 0 events — verifies metric line 6

## What's being built
- Each project gets an Autopilot switch in Admin: off, shadow or on. It is PIN-protected and logged.

## Reviewer findings
- **Architect** — `g15.approve` matches only the no-GitHub mock string at `orchestrator.js:890`. — **open** — action 1

## Actions
1. **Architect/Eng**: pick a real gate 15 fact and write it into the plan.
2. **Architect/Eng**: define a structured blocker marker in `farm/roles/caretaker.md`, e.g. a `## Blockers` section with open bullets.
3. **Eng**: revise the plan as follows:
   - Gate 13 reads structured output.
   - `loadPolicy` uses `readFarmFile`.

## Overlap
Checked against 4 other in-flight item(s) in `FinTekkers/horizon` (steps 6–13).
- **HZ-245** — decision: **depends-on**
