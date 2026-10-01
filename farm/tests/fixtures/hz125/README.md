# HZ-125's attempt-4 review rejection, recorded

HZ-182's replay: the rejection that should have led to a fix-only run and a
delta review, instead of a full implement and a full re-review.

| file | what it is |
| --- | --- |
| `verdict.json` | The review verdict of HZ-125 review attempt 4 (`step_run` 1168). Its findings are the feedback row that review wrote (`feedback` 160), verbatim. Severities come from that review's artifact: the first finding was under **Blocking**, the other three under **Notes**. `reviewed_sha` is the PR head that review read. |
| `dispatch.json` | The implement task the orchestrator must dispatch after `verdict.json` rejects. `feedback_message` is feedback 160 byte-for-byte. |
| `definitions.reviewed.txt` | `server/src/definitions.js` at `5f0477f`, the commit the review rejected: the unguarded `bucket[candidate]` lookup in `composeRole`. |
| `definitions.fixed.txt` | The same file at `adb44d7`, the fix that the next review passed. |

`server/test/fix-pass-hz125-replay.test.mjs` feeds `verdict.json` through the
orchestrator and asserts the dispatched task matches `dispatch.json`.
`farm/tests/test_hz125_replay.py` runs that same task, then a delta review
over the recorded fix.

`.txt`, not `.js`, deliberately: these are inert test data. Nothing should
import or lint them as source.
