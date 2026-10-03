"""HZ-273: the Autopilot caretaker's ruling PROPOSAL.

One bounded agent call, no tools: given the `Operator must decide:` request and
the item's current metric and guardrails, the model proposes a line-level
rewording as JSON. Nothing here writes anything. The Node server checks the
proposal in code (server/src/caretakerRulingRules.js) and is the only thing
that edits the GitHub issue; a proposal this module cannot parse comes back as
{"unsure": true}, which the server treats as "leave it for the human".

farmd's POST /caretaker/ruling is the only caller.

Called through the agent_runner MODULE, not a bound `run_agent` name, so a
test that patches agent_runner.run_agent really stands in for the model.
"""

from pathlib import Path

from . import agent_runner
from .agent_runner import AgentError

ROLE_PATH = Path(__file__).parent / "roles" / "caretaker_ruling.md"
# The caretaker's ruling is a PM judgement call; its model is the PM's.
RULING_MODEL_AGENT = "pm"
RULING_MAX_TURNS = 1
RULING_AGENT_S = 150

REQUIRED_KEYS = ("item_id", "request", "metric", "guardrails")


def _prompt(item_id: str, request: str, metric: str, guardrails: str) -> str:
    return (
        f"Work item {item_id} needs an operator ruling.\n\n"
        f"## The request\n{request}\n\n"
        f"## Success metric (current, verbatim)\n{metric}\n\n"
        f"## Guardrails (current, verbatim)\n{guardrails}\n\n"
        "Reply with the JSON object your instructions describe, and nothing else."
    )


def propose(item_id: str, request: str, metric: str, guardrails: str, log=print) -> dict:
    """The model's proposal as a dict, or {"unsure": True, "reason": ...} when
    it could not give a usable one. Never raises for a model failure."""
    try:
        reply = agent_runner.run_agent(
            _prompt(item_id, request, metric, guardrails),
            agent=RULING_MODEL_AGENT,
            append_system=ROLE_PATH.read_text(),
            max_turns=RULING_MAX_TURNS,
            timeout_s=RULING_AGENT_S,
        )
        parsed, notes = agent_runner.parse_agent_reply(reply.get("result") or "")
    except (AgentError, ValueError) as exc:
        log(f"caretaker_ruling: no usable ruling for {item_id}: {exc}")
        return {"unsure": True, "reason": "the ruling agent did not return a usable answer"}
    # Fail closed: a reply the parser had to repair is not trusted to edit the
    # issue body, and its notes say why.
    if notes:
        return {"unsure": True, "reason": "the ruling reply needed repair: " + "; ".join(notes)}
    if not isinstance(parsed, dict):
        return {"unsure": True, "reason": "the ruling agent did not return a JSON object"}
    return parsed
