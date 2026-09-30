"""HZ-124 metric 8 (provider-agnostic half): AgentExhaustedError carries
whatever partial_text/session_id a provider managed to capture before
exhausting its turn/time budget, without breaking the pre-existing
single-arg call sites every provider used before HZ-124."""

import pytest

from farm.providers.base import AgentError, AgentExhaustedError


def test_agent_exhausted_error_carries_partial_text_and_session_id():
    exc = AgentExhaustedError("claude timed out after 5s", partial_text="partial reply...", session_id="sess-1")
    assert str(exc) == "claude timed out after 5s"
    assert exc.partial_text == "partial reply..."
    assert exc.session_id == "sess-1"


def test_agent_exhausted_error_defaults_keep_the_old_single_arg_call_sites_working():
    exc = AgentExhaustedError("claude timed out after 5s")
    assert exc.partial_text == ""
    assert exc.session_id is None


def test_agent_exhausted_error_is_still_an_agent_error():
    with pytest.raises(AgentError):
        raise AgentExhaustedError("boom", partial_text="x", session_id="y")
