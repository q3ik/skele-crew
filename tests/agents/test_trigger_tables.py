"""
Tests for trigger table presence and correctness in agent files.

Validates the acceptance criteria from the issue:
- COO agent has trigger table: legal questions → Lawyer, cross-product → Self
- Marketing agent has trigger table: metric claims → Lawyer
- Accountant agent has trigger table: monthly → COO, quarterly → COO
- All agents have the canonical consultation heuristic
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

AGENTS_DIR = Path(__file__).resolve().parents[2] / ".github" / "agents"

CANONICAL_HEURISTIC = (
    "If your output involves: money amounts, legal claims, auth systems, or cross-product"
    " changes → pause and request peer review before acting, even if no explicit trigger fires."
)


def _read_agent(name: str) -> str:
    return (AGENTS_DIR / name).read_text(encoding="utf-8")


def _parse_trigger_table(content: str) -> list[tuple[str, str]]:
    """Extract rows from the first ## Trigger Table markdown table in *content*.

    Returns a list of (trigger_condition, must_consult) tuples (lower-cased for
    comparison convenience).
    """
    # Locate the section
    match = re.search(r"## Trigger Table\s*\n", content)
    if not match:
        return []

    section = content[match.end():]
    rows: list[tuple[str, str]] = []

    for line in section.splitlines():
        line = line.strip()
        # Stop at the next heading
        if line.startswith("##"):
            break
        if not line.startswith("|"):
            continue
        parts = [p.strip() for p in line.strip("|").split("|")]
        if len(parts) < 2:
            continue
        # Skip header/separator rows
        if parts[0].startswith("-") or parts[0].lower() == "trigger condition":
            continue
        rows.append((parts[0].lower(), parts[1].lower()))

    return rows


# ---------------------------------------------------------------------------
# COO trigger table tests
# ---------------------------------------------------------------------------

class TestCOOTriggerTable:
    @pytest.fixture(scope="class")
    def coo_content(self) -> str:
        return _read_agent("coo.agent.md")

    def test_coo_has_trigger_table_section(self, coo_content: str) -> None:
        assert "## Trigger Table" in coo_content

    def test_coo_legal_compliance_consults_lawyer(self, coo_content: str) -> None:
        rows = _parse_trigger_table(coo_content)
        legal_rows = [(t, c) for t, c in rows if "legal" in t]
        assert legal_rows, "COO trigger table must include a legal compliance row"
        _, consult = legal_rows[0]
        assert "lawyer" in consult

    def test_coo_cross_product_consults_self(self, coo_content: str) -> None:
        rows = _parse_trigger_table(coo_content)
        cross_rows = [(t, c) for t, c in rows if "cross-product" in t]
        assert cross_rows, "COO trigger table must include a cross-product impact row"
        _, consult = cross_rows[0]
        assert "self" in consult


# ---------------------------------------------------------------------------
# Marketing trigger table tests
# ---------------------------------------------------------------------------

class TestMarketingTriggerTable:
    @pytest.fixture(scope="class")
    def marketing_content(self) -> str:
        return _read_agent("marketing.agent.md")

    def test_marketing_has_trigger_table_section(self, marketing_content: str) -> None:
        assert "## Trigger Table" in marketing_content

    def test_marketing_metric_claim_consults_lawyer(self, marketing_content: str) -> None:
        rows = _parse_trigger_table(marketing_content)
        metric_rows = [(t, c) for t, c in rows if "metric" in t or "accuracy" in t]
        assert metric_rows, "Marketing trigger table must include a metric/accuracy claim row"
        _, consult = metric_rows[0]
        assert "lawyer" in consult


# ---------------------------------------------------------------------------
# Accountant trigger table tests
# ---------------------------------------------------------------------------

class TestAccountantTriggerTable:
    @pytest.fixture(scope="class")
    def accountant_content(self) -> str:
        return _read_agent("accountant.agent.md")

    def test_accountant_has_trigger_table_section(self, accountant_content: str) -> None:
        assert "## Trigger Table" in accountant_content

    def test_accountant_monthly_consults_coo(self, accountant_content: str) -> None:
        rows = _parse_trigger_table(accountant_content)
        monthly_rows = [(t, c) for t, c in rows if "monthly" in t]
        assert monthly_rows, "Accountant trigger table must include a monthly row"
        _, consult = monthly_rows[0]
        assert "coo" in consult

    def test_accountant_quarterly_consults_coo(self, accountant_content: str) -> None:
        rows = _parse_trigger_table(accountant_content)
        quarterly_rows = [(t, c) for t, c in rows if "quarterly" in t]
        assert quarterly_rows, "Accountant trigger table must include a quarterly row"
        _, consult = quarterly_rows[0]
        assert "coo" in consult


# ---------------------------------------------------------------------------
# Consultation heuristic tests (all agents)
# ---------------------------------------------------------------------------

class TestConsultationHeuristic:
    @pytest.mark.parametrize("agent_file", [
        "coo.agent.md",
        "marketing.agent.md",
        "accountant.agent.md",
    ])
    def test_agent_has_consultation_heuristic_section(self, agent_file: str) -> None:
        content = _read_agent(agent_file)
        assert "## Consultation Heuristic" in content, (
            f"{agent_file} must contain a '## Consultation Heuristic' section"
        )

    @pytest.mark.parametrize("agent_file", [
        "coo.agent.md",
        "marketing.agent.md",
        "accountant.agent.md",
    ])
    def test_agent_heuristic_matches_canonical_text(self, agent_file: str) -> None:
        content = _read_agent(agent_file)
        # Find the heuristic section and extract the text on the next line.
        match = re.search(r"## Consultation Heuristic\s*\n([^\n]+)", content)
        assert match, f"{agent_file} could not find '## Consultation Heuristic' section text"

        heuristic_text = match.group(1).strip()
        assert heuristic_text == CANONICAL_HEURISTIC, (
            f"{agent_file} consultation heuristic does not match the canonical text.\n"
            f"  Expected: '{CANONICAL_HEURISTIC}'\n"
            f"  Got:      '{heuristic_text}'"
        )
