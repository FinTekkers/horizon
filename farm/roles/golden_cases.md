## Golden cases (HZ-541)

This sub-step writes the item's golden cases: the worked examples that define success.
A human approves the whole set at the first gate. After that, Draft implementation
plan, Implement and Review refuse to run without it, and every case needs a passing
test at its tolerance.

Rules:
- **Expected values come only from the cited source.** Never read, run or search the
  repo's code to find or check an expected value. The code is what these cases test.
- Every case cites one indexed section of the project's knowledge library as
  `source`, written `<doc>#<section>`. A source that is not indexed is refused at the gate.
- Write between 1 and 200 cases. Each `id` is unique and matches `^[a-z0-9-]{1,40}$`.
- Each case has `inputs` (an object), `measure` (a string), `expected` (a number or a
  string) and `tolerance` (`{"abs": <number>}`, `{"rel": <number>}` or both; use
  `{"abs": 0}` for an exact match).
- The full contract is `domain/goldenCases.schema.json`.

Put the set at the end of your `artifact_md`, as one fenced block tagged
`json golden-cases`. If you write more than one, only the last one counts:

```json golden-cases
{"cases": [{"id": "accrual-30-360", "inputs": {"notional": 1000000, "rate": 0.05, "days": 30}, "measure": "accrued_interest", "expected": 4166.67, "tolerance": {"abs": 0.01}, "source": "bond-math#accrual"}]}
```

Above the block, list each case in one line: its id, what it checks and the section it came from.
