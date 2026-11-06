"""HZ-729: the independent review of one ask.

One bounded agent call, no tools, one turn, on the provider the server chose —
never the ask's author's. The input is the ask draft, the project rules and
the overlap matches the server computed, plus the ask's step name, kind and
why; the project's other open items, its items abandoned in the last 14 days,
the other open asks from the same step, and the parent item's description
(HZ-793). Nothing else goes into the prompt: no transcript, workspace, host
path or session.

Nothing here writes anything. The Node server (server/src/askReview.js)
checks the reply in code and stores it on its own ask_review table. A reply
this module cannot use comes back as an `escalate` marked "unusable", which
the server stores as a failed review rather than a real verdict.

farmd's POST /ask/review is the only caller. Called through the agent_runner
MODULE, not a bound `run_agent` name, so a test that patches
agent_runner.run_agent really stands in for the model.
"""

import json
from pathlib import Path

from . import agent_runner, rules
from .agent_runner import AgentError, AgentUsageLimitedError

ROLE_PATH = Path(__file__).parent / "roles" / "ask_review.md"
# The review is a PM judgement call; its model is the PM's on Claude, and the
# server names the exact model for any provider.
REVIEW_MODEL_AGENT = "pm"
REVIEW_MAX_TURNS = 1
REVIEW_AGENT_S = 150
# No tools: the reviewer reads the prompt and answers.
REVIEW_TOOLS = ""

REQUIRED_KEYS = ("ask_id", "provider", "step", "draft", "repo")
DRAFT_FIELDS = ("title", "repo", "outcome", "metric", "guardrails")


class ReviewUnavailable(Exception):
    """The provider refused before reviewing — a usage limit. farmd returns
    503 so the server keeps the ask awaiting review; no verdict is made up."""


def _section(title: str, value) -> str:
    return f"## {title}\n{value}\n"


def _prompt(body: dict) -> str:
    draft = body["draft"]
    lines = [f"An ask raised at the step “{body['step']}” needs an independent review.\n"]
    lines.append(_section("Ask", f"kind: {body.get('kind') or 'unknown'}\nwhy: {body.get('why') or ''}"))
    for field in DRAFT_FIELDS:
        lines.append(_section(f"Draft {field}", draft.get(field, "")))
    lines.append(_section("Overlap matches (computed by the server)", json.dumps(body.get("matches") or [], indent=2)))
    lines.append(_section("Open items in this project", json.dumps(body.get("candidates") or [], indent=2)))
    lines.append(_section("Items abandoned in the last 14 days", json.dumps(body.get("abandoned") or [], indent=2)))
    lines.append(_section("Other open asks from the same step", json.dumps(body.get("siblings") or [], indent=2)))
    lines.append(_section("Parent item (id, title, description)", json.dumps(body.get("parent") or {}, indent=2)))
    lines.append("Reply with the JSON object your instructions describe, and nothing else.")
    return "\n".join(lines)


def _system(body: dict) -> str:
    parts = rules.resolve_rules(body.get("project"), body.get("repo"), body.get("rules_override"))
    section = rules.render_rules_section(parts)
    role = ROLE_PATH.read_text()
    return f"{role}\n\n{section}" if section else role


def _unusable(provider, reason: str) -> dict:
    return {"verdict": "escalate", "reasons": [reason], "provider": provider, "unusable": True}


def review(body: dict, log=print) -> dict:
    """The reviewer's reply as a dict carrying the provider that ran. Raises
    ReviewUnavailable on a usage limit; any other model failure comes back as
    an unusable escalate. Never falls back to another provider."""
    provider = body["provider"]
    # The exact model the server checked for usage limits; the farm drops it
    # if that provider does not declare it.
    model_choice = body.get("model") or None
    try:
        reply = agent_runner.run_agent(
            _prompt(body),
            agent=REVIEW_MODEL_AGENT,
            provider=provider,
            model_choice=model_choice,
            append_system=_system(body),
            max_turns=REVIEW_MAX_TURNS,
            timeout_s=REVIEW_AGENT_S,
            allowed_tools=REVIEW_TOOLS,
        )
    except AgentUsageLimitedError as exc:
        raise ReviewUnavailable(f"usage limited until {exc.reset_at}" if exc.reset_at else "usage limited") from exc
    except AgentError as exc:
        log(f"ask_review: no usable review for ask {body['ask_id']}: {exc}")
        return _unusable(provider, "the reviewer did not return a usable answer")
    ran = reply.get("provider") or provider
    try:
        parsed, notes = agent_runner.parse_agent_reply(reply.get("result") or "")
    except (AgentError, ValueError) as exc:
        log(f"ask_review: unparseable review for ask {body['ask_id']}: {exc}")
        return _unusable(ran, "the reviewer's reply was not JSON")
    # Fail closed: a reply the parser had to repair is not trusted.
    if notes:
        return _unusable(ran, "the reviewer's reply needed repair: " + "; ".join(notes))
    if not isinstance(parsed, dict):
        return _unusable(ran, "the reviewer did not return a JSON object")
    # Only the farm marks a reply unusable; the model cannot.
    kept = {key: value for key, value in parsed.items() if key != "unusable"}
    return {**kept, "provider": ran, "model": reply.get("model")}
