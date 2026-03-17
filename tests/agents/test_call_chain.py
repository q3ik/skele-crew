"""
Tests for inter-agent call-chain tracking protocol.

Validates the two core safety rules:
1. Max depth of 3 — a chain at depth 3 cannot call further agents.
2. No-callback rule — an agent already in the chain cannot be called again.

These tests implement a minimal call-chain validator that mirrors the logic
every agent is expected to apply before making a peer review request.
"""

from __future__ import annotations

from typing import List

import pytest


# ---------------------------------------------------------------------------
# Call-chain logic — mirrors the protocol in
# .github/instructions/call-chain-protocol.md
# ---------------------------------------------------------------------------

MAX_DEPTH = 3


def can_call(chain: List[str], target: str) -> tuple[bool, str]:
    """Return (allowed, reason) for a proposed call from the end of *chain*
    to *target*.

    Rules enforced:
    - *target* must not already appear in *chain* (no-callback rule).
    - Depth must not exceed MAX_DEPTH after the call.
    """
    if target in chain:
        return False, f"no-callback: {target!r} already appears in chain {chain!r}"
    new_depth = len(chain) + 1
    if new_depth > MAX_DEPTH:
        return False, f"depth {new_depth} exceeds maximum of {MAX_DEPTH}"
    return True, "ok"


def extend_chain(chain: List[str], next_agent: str) -> List[str]:
    """Return a new chain with *next_agent* appended."""
    allowed, reason = can_call(chain, next_agent)
    if not allowed:
        raise ValueError(reason)
    return chain + [next_agent]


# ---------------------------------------------------------------------------
# 1. Max-depth tests
# ---------------------------------------------------------------------------

class TestMaxDepth:
    def test_depth_1_chain_is_allowed(self) -> None:
        """COO (depth 1) can call Marketing (resulting depth 2)."""
        chain: List[str] = ["COO"]
        allowed, _ = can_call(chain, "Marketing")
        assert allowed

    def test_depth_2_chain_is_allowed(self) -> None:
        """COO → Marketing (depth 2) can call Lawyer (resulting depth 3)."""
        chain = ["COO", "Marketing"]
        allowed, _ = can_call(chain, "Lawyer")
        assert allowed

    def test_depth_3_call_is_blocked(self) -> None:
        """A chain already at depth 3 cannot call another agent (would be depth 4)."""
        chain = ["COO", "Marketing", "Lawyer"]
        allowed, reason = can_call(chain, "Accountant")
        assert not allowed
        assert "exceeds maximum" in reason

    def test_depth_3_blocked_error_message_mentions_depth(self) -> None:
        chain = ["COO", "Marketing", "Lawyer"]
        _, reason = can_call(chain, "Accountant")
        assert "4" in reason  # new_depth would be 4

    def test_empty_chain_can_call_any_agent(self) -> None:
        """An empty chain (depth 0 → 1) is always allowed."""
        chain: List[str] = []
        allowed, _ = can_call(chain, "COO")
        assert allowed

    def test_extend_chain_raises_at_depth_4(self) -> None:
        chain = ["COO", "Marketing", "Lawyer"]
        with pytest.raises(ValueError, match="exceeds maximum"):
            extend_chain(chain, "Accountant")

    def test_chain_at_depth_2_can_still_extend(self) -> None:
        chain = ["COO", "Marketing"]
        new_chain = extend_chain(chain, "Lawyer")
        assert new_chain == ["COO", "Marketing", "Lawyer"]

    def test_max_depth_constant_is_3(self) -> None:
        assert MAX_DEPTH == 3


# ---------------------------------------------------------------------------
# 2. No-callback rule tests
# ---------------------------------------------------------------------------

class TestNoCallbackRule:
    def test_callback_to_coo_is_blocked(self) -> None:
        """COO → Marketing → COO is not allowed."""
        chain = ["COO", "Marketing"]
        allowed, reason = can_call(chain, "COO")
        assert not allowed
        assert "no-callback" in reason

    def test_callback_to_middle_agent_is_blocked(self) -> None:
        """COO → Marketing → Lawyer → Marketing is not allowed."""
        chain = ["COO", "Marketing", "Lawyer"]
        # Lawyer wants to call Marketing back — blocked by no-callback rule
        allowed, reason = can_call(chain, "Marketing")
        assert not allowed
        assert "no-callback" in reason

    def test_direct_self_call_is_blocked(self) -> None:
        """An agent cannot call itself."""
        chain = ["COO", "Marketing"]
        allowed, reason = can_call(chain, "Marketing")
        assert not allowed
        assert "no-callback" in reason

    def test_extend_chain_raises_on_callback(self) -> None:
        chain = ["COO", "Marketing"]
        with pytest.raises(ValueError, match="no-callback"):
            extend_chain(chain, "COO")

    def test_new_agent_not_in_chain_is_allowed(self) -> None:
        """Accountant is not yet in chain, so the call is permitted."""
        chain = ["COO", "Marketing"]
        allowed, _ = can_call(chain, "Accountant")
        assert allowed

    def test_callback_reason_names_the_blocked_agent(self) -> None:
        chain = ["COO", "Marketing"]
        _, reason = can_call(chain, "Marketing")
        assert "Marketing" in reason

    def test_callback_a_to_b_to_a(self) -> None:
        """Simulate the canonical A → B → A callback scenario."""
        # Step 1: A calls B — allowed
        chain_ab: List[str] = []
        chain_ab = extend_chain(chain_ab, "AgentA")
        chain_ab = extend_chain(chain_ab, "AgentB")

        # Step 2: B tries to call A back — blocked
        allowed, reason = can_call(chain_ab, "AgentA")
        assert not allowed
        assert "no-callback" in reason

    def test_full_three_hop_chain_blocks_any_further_call(self) -> None:
        """COO → Marketing → Lawyer cannot call anyone at depth 4."""
        chain = extend_chain([], "COO")
        chain = extend_chain(chain, "Marketing")
        chain = extend_chain(chain, "Lawyer")

        for agent in ["Accountant", "COO", "Marketing", "Improver"]:
            allowed, _ = can_call(chain, agent)
            assert not allowed, f"Expected {agent!r} to be blocked but it was allowed"
