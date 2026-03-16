"""
Tests for Accountant agent behaviour:
1. Writing a quarterly HST deadline entity to the knowledge graph — verify
   format and retention policy.
2. Detecting an overdue filing — verify BOARD.md Overdue section is updated.

All I/O is routed through tmp_path so the real files are never touched.
"""

from __future__ import annotations

import json
import re
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pytest


# ---------------------------------------------------------------------------
# Helpers — shared with tests/memory tests but kept local to avoid coupling
# ---------------------------------------------------------------------------

def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    """Read every valid JSON line from *path*; skip empty/corrupt lines."""
    records: list[dict[str, Any]] = []
    if not path.exists():
        return records
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return records


def _write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(json.dumps(r) for r in records) + ("\n" if records else ""),
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# Accountant logic — minimal Python implementation that mirrors what the
# Accountant agent is expected to do (write deadline entities, flag overdue).
# ---------------------------------------------------------------------------

def _quarter_label(d: date) -> str:
    """Return 'YYYY-QN' for the HST quarter that *d* falls in."""
    quarter = (d.month - 1) // 3 + 1
    return f"{d.year}-Q{quarter}"


def _hst_due_date(quarter_label: str) -> date:
    """Return the HST filing due date (last day of month after quarter end).

    Quarter ends:  Q1→Mar 31, Q2→Jun 30, Q3→Sep 30, Q4→Dec 31
    Due dates:     Q1→Apr 30, Q2→Jul 31, Q3→Oct 31, Q4→Jan 31 (next year)
    """
    year, q = quarter_label.split("-Q")
    year = int(year)
    quarter = int(q)
    # Month *after* the quarter end month
    due_month = quarter * 3 + 1  # Q1→4, Q2→7, Q3→10, Q4→13
    due_year = year
    if due_month == 13:
        due_month = 1
        due_year += 1
    # Last day of due_month
    # Find last day by going to the 1st of the next month and subtracting one day
    if due_month == 12:
        last_day = date(due_year + 1, 1, 1) - timedelta(days=1)
    else:
        last_day = date(due_year, due_month + 1, 1) - timedelta(days=1)
    return last_day


def write_hst_deadline_entity(graph_path: Path, quarter_label: str) -> dict[str, Any]:
    """Append an HST deadline entity to *graph_path* and return it."""
    due = _hst_due_date(quarter_label)
    entity: dict[str, Any] = {
        "type": "entity",
        "name": f"deadline:{quarter_label}:hst-filing",
        "entityType": "deadline",
        "observations": [
            f"due: {due.isoformat()}",
            "owner: accountant",
            "status: pending",
            "type: tax",
            "jurisdiction: ontario-canada",
            "filing: hst-quarterly",
            "retention: permanent",
        ],
    }
    existing = _load_jsonl(graph_path)
    # Idempotent: don't duplicate
    if not any(r.get("name") == entity["name"] for r in existing):
        existing.append(entity)
        _write_jsonl(graph_path, existing)
    return entity


def flag_overdue_filings(graph_path: Path, board_path: Path, today: date) -> list[str]:
    """Scan *graph_path* for overdue deadline entities and update *board_path*.

    Returns the list of filing names that were flagged as overdue.
    """
    records = _load_jsonl(graph_path)
    flagged: list[str] = []

    for record in records:
        if record.get("type") != "entity":
            continue
        if record.get("entityType") != "deadline":
            continue
        observations: list[str] = record.get("observations", [])
        obs_map: dict[str, str] = {}
        for obs in observations:
            if ": " in obs:
                k, v = obs.split(": ", 1)
                obs_map[k] = v

        status = obs_map.get("status", "")
        due_str = obs_map.get("due", "")
        if not due_str or status == "overdue":
            continue

        try:
            due_date = date.fromisoformat(due_str)
        except ValueError:
            continue

        if due_date < today:
            days_overdue = (today - due_date).days
            name: str = record["name"]
            filing_type = obs_map.get("filing", name)

            _update_board_overdue(board_path, filing_type, due_date, days_overdue)
            flagged.append(name)

    return flagged


def _update_board_overdue(
    board_path: Path, filing_type: str, due_date: date, days_overdue: int
) -> None:
    """Add (or replace) an overdue row in BOARD.md's Overdue section."""
    if not board_path.exists():
        return

    content = board_path.read_text(encoding="utf-8")

    row = (
        f"| {filing_type} | Accountant | {due_date.isoformat()} | {days_overdue} days |"
    )

    # Remove the "none" placeholder if present
    content = re.sub(r"\| _\(none\)_ \|.*\n", "", content)

    # Insert after the overdue table header
    header_pattern = r"(\| Task \| Owner \| Due \| Days Overdue \|\n\|[-| ]+\|\n)"
    if re.search(header_pattern, content):
        content = re.sub(
            header_pattern,
            lambda m: m.group(0) + row + "\n",
            content,
        )
    else:
        # Fallback: append after 🔴 Overdue heading
        content = content.replace(
            "## 🔴 Overdue\n",
            f"## 🔴 Overdue\n{row}\n",
        )

    board_path.write_text(content, encoding="utf-8")


# ---------------------------------------------------------------------------
# 1. Deadline entity format and retention tests
# ---------------------------------------------------------------------------

class TestDeadlineEntityFormat:
    def test_hst_entity_has_required_fields(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        entity = write_hst_deadline_entity(graph, "2026-Q2")

        assert entity["type"] == "entity"
        assert entity["entityType"] == "deadline"
        assert entity["name"] == "deadline:2026-Q2:hst-filing"

    def test_hst_entity_name_format(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        entity = write_hst_deadline_entity(graph, "2026-Q1")

        assert re.match(r"^deadline:\d{4}-Q[1-4]:hst-filing$", entity["name"])

    def test_hst_entity_observations_include_due_date(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        entity = write_hst_deadline_entity(graph, "2026-Q1")

        obs = entity["observations"]
        due_obs = [o for o in obs if o.startswith("due: ")]
        assert len(due_obs) == 1
        # Q1 due date is April 30
        assert due_obs[0] == "due: 2026-04-30"

    def test_hst_q2_due_date_is_july_31(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        entity = write_hst_deadline_entity(graph, "2026-Q2")

        obs_map = {o.split(": ", 1)[0]: o.split(": ", 1)[1] for o in entity["observations"] if ": " in o}
        assert obs_map["due"] == "2026-07-31"

    def test_hst_q3_due_date_is_october_31(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        entity = write_hst_deadline_entity(graph, "2026-Q3")

        obs_map = {o.split(": ", 1)[0]: o.split(": ", 1)[1] for o in entity["observations"] if ": " in o}
        assert obs_map["due"] == "2026-10-31"

    def test_hst_q4_due_date_is_january_31_next_year(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        entity = write_hst_deadline_entity(graph, "2026-Q4")

        obs_map = {o.split(": ", 1)[0]: o.split(": ", 1)[1] for o in entity["observations"] if ": " in o}
        assert obs_map["due"] == "2027-01-31"

    def test_hst_entity_has_retention_permanent(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        entity = write_hst_deadline_entity(graph, "2026-Q2")

        assert "retention: permanent" in entity["observations"]

    def test_hst_entity_has_owner_accountant(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        entity = write_hst_deadline_entity(graph, "2026-Q2")

        assert "owner: accountant" in entity["observations"]

    def test_hst_entity_has_jurisdiction_ontario(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        entity = write_hst_deadline_entity(graph, "2026-Q2")

        assert "jurisdiction: ontario-canada" in entity["observations"]

    def test_hst_entity_written_to_graph_file(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        write_hst_deadline_entity(graph, "2026-Q2")

        assert graph.exists()
        records = _load_jsonl(graph)
        names = [r.get("name") for r in records]
        assert "deadline:2026-Q2:hst-filing" in names

    def test_write_is_idempotent(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        write_hst_deadline_entity(graph, "2026-Q2")
        write_hst_deadline_entity(graph, "2026-Q2")  # second call

        records = _load_jsonl(graph)
        matching = [r for r in records if r.get("name") == "deadline:2026-Q2:hst-filing"]
        assert len(matching) == 1, "Duplicate deadline entities must not be written"

    def test_entity_is_valid_json_line(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        write_hst_deadline_entity(graph, "2026-Q2")

        for line in graph.read_text(encoding="utf-8").splitlines():
            if line.strip():
                json.loads(line)  # must not raise

    def test_entity_status_starts_as_pending(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        entity = write_hst_deadline_entity(graph, "2026-Q2")

        assert "status: pending" in entity["observations"]


# ---------------------------------------------------------------------------
# 2. Overdue filing detection and BOARD.md update tests
# ---------------------------------------------------------------------------

_BOARD_TEMPLATE = """\
# Sprint Board

> Maintained by COO Agent. Updated during daily standup.
> Last updated: [DATE]

## 🔴 Overdue

| Task | Owner | Due | Days Overdue |
|------|-------|-----|-------------|
| _(none)_ | | | |

## 🟡 In Progress

| Task | Owner | Started | Notes |
|------|-------|---------|-------|
| _(none)_ | | | |
"""


class TestOverdueFilingDetection:
    def test_overdue_filing_is_flagged(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        board = tmp_path / "BOARD.md"
        board.write_text(_BOARD_TEMPLATE, encoding="utf-8")

        # Plant a deadline that is clearly in the past
        past_due = date(2026, 1, 31)
        _write_jsonl(graph, [
            {
                "type": "entity",
                "name": "deadline:2025-Q4:hst-filing",
                "entityType": "deadline",
                "observations": [
                    f"due: {past_due.isoformat()}",
                    "owner: accountant",
                    "status: pending",
                    "type: tax",
                    "jurisdiction: ontario-canada",
                    "filing: hst-quarterly",
                    "retention: permanent",
                ],
            }
        ])

        today = date(2026, 3, 15)
        flagged = flag_overdue_filings(graph, board, today)

        assert "deadline:2025-Q4:hst-filing" in flagged

    def test_overdue_filing_updates_board_md(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        board = tmp_path / "BOARD.md"
        board.write_text(_BOARD_TEMPLATE, encoding="utf-8")

        past_due = date(2026, 1, 31)
        _write_jsonl(graph, [
            {
                "type": "entity",
                "name": "deadline:2025-Q4:hst-filing",
                "entityType": "deadline",
                "observations": [
                    f"due: {past_due.isoformat()}",
                    "owner: accountant",
                    "status: pending",
                    "type: tax",
                    "jurisdiction: ontario-canada",
                    "filing: hst-quarterly",
                    "retention: permanent",
                ],
            }
        ])

        today = date(2026, 3, 15)
        flag_overdue_filings(graph, board, today)

        board_content = board.read_text(encoding="utf-8")
        assert "hst-quarterly" in board_content
        assert "Accountant" in board_content
        assert "2026-01-31" in board_content

    def test_overdue_entry_shows_days_overdue(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        board = tmp_path / "BOARD.md"
        board.write_text(_BOARD_TEMPLATE, encoding="utf-8")

        past_due = date(2026, 1, 31)
        _write_jsonl(graph, [
            {
                "type": "entity",
                "name": "deadline:2025-Q4:hst-filing",
                "entityType": "deadline",
                "observations": [
                    f"due: {past_due.isoformat()}",
                    "owner: accountant",
                    "status: pending",
                    "type: tax",
                    "jurisdiction: ontario-canada",
                    "filing: hst-quarterly",
                    "retention: permanent",
                ],
            }
        ])

        today = date(2026, 3, 15)  # 43 days after Jan 31
        flag_overdue_filings(graph, board, today)

        board_content = board.read_text(encoding="utf-8")
        assert "43 days" in board_content

    def test_future_deadline_is_not_flagged(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        board = tmp_path / "BOARD.md"
        board.write_text(_BOARD_TEMPLATE, encoding="utf-8")

        future_due = date(2026, 7, 31)
        _write_jsonl(graph, [
            {
                "type": "entity",
                "name": "deadline:2026-Q2:hst-filing",
                "entityType": "deadline",
                "observations": [
                    f"due: {future_due.isoformat()}",
                    "owner: accountant",
                    "status: pending",
                    "type: tax",
                    "jurisdiction: ontario-canada",
                    "filing: hst-quarterly",
                    "retention: permanent",
                ],
            }
        ])

        today = date(2026, 3, 15)
        flagged = flag_overdue_filings(graph, board, today)

        assert "deadline:2026-Q2:hst-filing" not in flagged

    def test_already_overdue_status_not_reflagged(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        board = tmp_path / "BOARD.md"
        board.write_text(_BOARD_TEMPLATE, encoding="utf-8")

        past_due = date(2026, 1, 31)
        _write_jsonl(graph, [
            {
                "type": "entity",
                "name": "deadline:2025-Q4:hst-filing",
                "entityType": "deadline",
                "observations": [
                    f"due: {past_due.isoformat()}",
                    "owner: accountant",
                    "status: overdue",  # already flagged
                    "type: tax",
                    "jurisdiction: ontario-canada",
                    "filing: hst-quarterly",
                    "retention: permanent",
                ],
            }
        ])

        today = date(2026, 3, 15)
        flagged = flag_overdue_filings(graph, board, today)

        assert "deadline:2025-Q4:hst-filing" not in flagged

    def test_empty_graph_yields_no_flagged_filings(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        board = tmp_path / "BOARD.md"
        board.write_text(_BOARD_TEMPLATE, encoding="utf-8")

        flagged = flag_overdue_filings(graph, board, date(2026, 3, 15))

        assert flagged == []

    def test_board_none_placeholder_removed_when_overdue_added(
        self, tmp_path: Path
    ) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        board = tmp_path / "BOARD.md"
        board.write_text(_BOARD_TEMPLATE, encoding="utf-8")

        _write_jsonl(graph, [
            {
                "type": "entity",
                "name": "deadline:2025-Q4:hst-filing",
                "entityType": "deadline",
                "observations": [
                    "due: 2026-01-31",
                    "owner: accountant",
                    "status: pending",
                    "type: tax",
                    "jurisdiction: ontario-canada",
                    "filing: hst-quarterly",
                    "retention: permanent",
                ],
            }
        ])

        flag_overdue_filings(graph, board, date(2026, 3, 15))

        board_content = board.read_text(encoding="utf-8")
        assert "_(none)_" not in board_content.split("## 🔴 Overdue")[1].split("## 🟡")[0]
