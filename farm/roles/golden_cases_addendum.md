## Golden cases (HZ-541)

This item has a golden-cases sub-step. It writes a set of golden cases, and a human
approves the whole set at the first gate. Expected values come only from each case's
cited `<doc>#<section>`, never from the code under test.

- **Success metric:** write exactly one metric line that references the set, and put
  the token `golden_cases` on that line and on no other line. For example:
  `3. Every approved golden_cases case has a passing test at its stated tolerance.`
  The first-gate table links every case to that line.
- **Draft implementation plan:** plan one test per approved case id. Each test checks
  the case's `measure` against its `expected` value within its `tolerance`. Take the
  values from the "Approved golden cases" artifact only.
