"""
Tests for scripts/check-drift.sh — COO coach check drift detection.

Each test creates an isolated temporary directory containing:
  memory/knowledge-graph.jsonl — fabricated standup entities
  BOARD.md                     — sprint board (with/without completions)

Then invokes check-drift.sh via subprocess and validates the exit code and
stdout output against the acceptance criteria in the issue:

  - COO tracks standup cycle count (via metric entity in knowledge graph)
  - On every 3rd cycle, COO compares BOARD.md snapshots from 3 cycles ago
  - Drift detected: task in all 3 standups without completion → flagged
  - Drift report format:
      DRIFT DETECTED — [agent] committed to [action] on [date], no output found
  - Drift lesson entity written to knowledge graph
  - Test: manually add a carry-over task to 3 consecutive standup entities
    → verify drift is detected
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

# ---------------------------------------------------------------------------
# Path to the script under test
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parents[2]
CHECK_DRIFT_SH = REPO_ROOT / "scripts" / "check-drift.sh"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

MINIMAL_BOARD_MD = """\
# Sprint Board

> Maintained by COO Agent.

## 🔴 Overdue

| Task | Owner | Due | Days Overdue |
|------|-------|-----|-------------|
| _(none)_ | | | |

## 🟡 In Progress

| Task | Owner | Started | Notes |
|------|-------|---------|-------|
| _(none)_ | | | |

## 🟢 Completed (Last 7 Days)

| Task | Owner | Completed |
|------|-------|-----------|
| _(none)_ | | |

## 📅 Upcoming

| Task | Owner | Due |
|------|-------|-----|
"""


def _write_board(repo_root: Path, completed_tasks: list[str] | None = None) -> None:
    """Write a BOARD.md to *repo_root*.

    Parameters
    ----------
    repo_root:
        Temporary repo root directory.
    completed_tasks:
        Task names to include in the Completed table.  If omitted the table
        contains the ``_(none)_`` placeholder.
    """
    if not completed_tasks:
        (repo_root / "BOARD.md").write_text(MINIMAL_BOARD_MD, encoding="utf-8")
        return

    rows = "\n".join(
        f"| {task} | Copilot | 2026-03-17 |" for task in completed_tasks
    )
    board = MINIMAL_BOARD_MD.replace("| _(none)_ | | |", rows)
    (repo_root / "BOARD.md").write_text(board, encoding="utf-8")


def _write_standup_entity(
    graph_path: Path,
    date_str: str,
    delegations: str = "none",
) -> None:
    """Append a standup entity to *graph_path*."""
    record: dict[str, Any] = {
        "type": "entity",
        "name": f"standup:{date_str}",
        "entityType": "standup",
        "observations": [
            "errors: 0",
            "overdue-tasks: 0",
            f"delegations: {delegations}",
            "priority-1: none",
        ],
    }
    with graph_path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record) + "\n")


def _run_check_drift(repo_root: Path) -> subprocess.CompletedProcess[str]:
    """Invoke check-drift.sh with *repo_root* and return the CompletedProcess."""
    return subprocess.run(
        ["bash", str(CHECK_DRIFT_SH), "--repo-root", str(repo_root)],
        capture_output=True,
        text=True,
    )


def _read_graph(repo_root: Path) -> list[dict[str, Any]]:
    """Return parsed JSONL records from the knowledge graph."""
    graph_path = repo_root / "memory" / "knowledge-graph.jsonl"
    records: list[dict[str, Any]] = []
    for raw in graph_path.read_text(encoding="utf-8").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            records.append(json.loads(raw))
        except json.JSONDecodeError:
            pass
    return records


def _get_drift_lessons(repo_root: Path) -> list[dict[str, Any]]:
    """Return lesson entities whose names contain 'drift' from the knowledge graph."""
    return [
        r
        for r in _read_graph(repo_root)
        if r.get("entityType") == "lesson" and "drift" in r.get("name", "")
    ]


# ---------------------------------------------------------------------------
# 1. Core drift detection — carry-over task in all 3 standups
# ---------------------------------------------------------------------------


class TestDriftDetected:
    """The acceptance-criteria test: carry-over task in 3 consecutive standups."""

    def test_drift_detected_exit_code_is_1(self, tmp_path: Path) -> None:
        """Exit code must be 1 when drift is found."""
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        _write_standup_entity(graph, "2026-03-15", "→ Marketing: write launch tweet")
        _write_standup_entity(graph, "2026-03-16", "→ Marketing: write launch tweet")
        _write_standup_entity(graph, "2026-03-17", "→ Marketing: write launch tweet")
        _write_board(tmp_path)

        result = _run_check_drift(tmp_path)
        assert result.returncode == 1, (
            f"Expected exit 1 (drift), got {result.returncode}.\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )

    def test_drift_detected_output_format(self, tmp_path: Path) -> None:
        """Output line must match the canonical DRIFT DETECTED format."""
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        _write_standup_entity(graph, "2026-03-15", "→ Marketing: write launch tweet")
        _write_standup_entity(graph, "2026-03-16", "→ Marketing: write launch tweet")
        _write_standup_entity(graph, "2026-03-17", "→ Marketing: write launch tweet")
        _write_board(tmp_path)

        result = _run_check_drift(tmp_path)
        assert "DRIFT DETECTED" in result.stdout
        # Must mention agent, action, and date
        assert "marketing" in result.stdout.lower()
        assert "write launch tweet" in result.stdout.lower()
        assert "2026-03-15" in result.stdout  # committed_date = oldest of the 3

    def test_drift_detected_no_output_found_phrase(self, tmp_path: Path) -> None:
        """Output must contain 'no output found'."""
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        _write_standup_entity(graph, "2026-03-15", "→ Accountant: file HST return")
        _write_standup_entity(graph, "2026-03-16", "→ Accountant: file HST return")
        _write_standup_entity(graph, "2026-03-17", "→ Accountant: file HST return")
        _write_board(tmp_path)

        result = _run_check_drift(tmp_path)
        assert "no output found" in result.stdout.lower()

    def test_drift_detected_lesson_entity_written(self, tmp_path: Path) -> None:
        """A lesson entity must be appended to knowledge-graph.jsonl on drift."""
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        _write_standup_entity(graph, "2026-03-15", "→ Marketing: write launch tweet")
        _write_standup_entity(graph, "2026-03-16", "→ Marketing: write launch tweet")
        _write_standup_entity(graph, "2026-03-17", "→ Marketing: write launch tweet")
        _write_board(tmp_path)

        _run_check_drift(tmp_path)

        lessons = _get_drift_lessons(tmp_path)
        assert lessons, "Expected at least one drift lesson entity in the graph"

        lesson = lessons[-1]
        assert lesson.get("name", "").startswith("lesson:")

        obs_text = " ".join(lesson.get("observations", []))
        assert "missed-deadline" in obs_text
        assert "marketing" in obs_text.lower()
        assert "write launch tweet" in obs_text.lower()

    def test_drift_lesson_entity_has_required_observations(self, tmp_path: Path) -> None:
        """Lesson entity must include category, agent, summary, and action fields."""
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        _write_standup_entity(graph, "2026-03-15", "→ Accountant: file HST return")
        _write_standup_entity(graph, "2026-03-16", "→ Accountant: file HST return")
        _write_standup_entity(graph, "2026-03-17", "→ Accountant: file HST return")
        _write_board(tmp_path)

        _run_check_drift(tmp_path)

        lessons = _get_drift_lessons(tmp_path)
        assert lessons, "Drift lesson entity not found"
        lesson = lessons[-1]

        obs = lesson.get("observations", [])
        obs_keys = [o.split(":")[0] for o in obs if isinstance(o, str)]
        assert "category" in obs_keys
        assert "agent" in obs_keys
        assert "summary" in obs_keys
        assert "action" in obs_keys


# ---------------------------------------------------------------------------
# 2. No drift — task completed in BOARD.md
# ---------------------------------------------------------------------------


class TestNoDriftTaskCompleted:
    def test_no_drift_when_task_in_completed_section(self, tmp_path: Path) -> None:
        """If the delegation task is listed in BOARD.md completed, no drift."""
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        _write_standup_entity(graph, "2026-03-15", "→ Marketing: write launch tweet")
        _write_standup_entity(graph, "2026-03-16", "→ Marketing: write launch tweet")
        _write_standup_entity(graph, "2026-03-17", "→ Marketing: write launch tweet")
        _write_board(tmp_path, completed_tasks=["write launch tweet"])

        result = _run_check_drift(tmp_path)
        assert result.returncode == 0, (
            f"Expected exit 0 (no drift), got {result.returncode}.\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )
        assert "DRIFT DETECTED" not in result.stdout

    def test_no_lesson_entity_written_when_no_drift(self, tmp_path: Path) -> None:
        """No lesson entity must be written when the task is completed."""
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        _write_standup_entity(graph, "2026-03-15", "→ Marketing: write launch tweet")
        _write_standup_entity(graph, "2026-03-16", "→ Marketing: write launch tweet")
        _write_standup_entity(graph, "2026-03-17", "→ Marketing: write launch tweet")
        _write_board(tmp_path, completed_tasks=["write launch tweet"])

        before_records = _read_graph(tmp_path)
        _run_check_drift(tmp_path)
        after_records = _read_graph(tmp_path)

        assert len(after_records) == len(before_records), (
            "No new records should be written when there is no drift"
        )


# ---------------------------------------------------------------------------
# 3. No drift — fewer than 3 standups
# ---------------------------------------------------------------------------


class TestNoDriftInsufficientStandups:
    def test_no_drift_with_zero_standups(self, tmp_path: Path) -> None:
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        graph.write_text("", encoding="utf-8")
        _write_board(tmp_path)

        result = _run_check_drift(tmp_path)
        assert result.returncode == 0
        assert "DRIFT DETECTED" not in result.stdout

    def test_no_drift_with_two_standups(self, tmp_path: Path) -> None:
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        _write_standup_entity(graph, "2026-03-16", "→ Marketing: write launch tweet")
        _write_standup_entity(graph, "2026-03-17", "→ Marketing: write launch tweet")
        _write_board(tmp_path)

        result = _run_check_drift(tmp_path)
        assert result.returncode == 0
        assert "DRIFT DETECTED" not in result.stdout

    def test_no_drift_with_exactly_three_standups_different_delegations(
        self, tmp_path: Path
    ) -> None:
        """Three standups with different delegations → no carry-over → no drift."""
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        _write_standup_entity(graph, "2026-03-15", "→ Marketing: write launch tweet")
        _write_standup_entity(graph, "2026-03-16", "→ Marketing: write blog post")
        _write_standup_entity(graph, "2026-03-17", "→ Marketing: update social bio")
        _write_board(tmp_path)

        result = _run_check_drift(tmp_path)
        assert result.returncode == 0
        assert "DRIFT DETECTED" not in result.stdout


# ---------------------------------------------------------------------------
# 4. No drift — delegations are "none" / placeholder
# ---------------------------------------------------------------------------


class TestNoDriftNoopDelegations:
    def test_no_drift_when_all_delegations_are_none(self, tmp_path: Path) -> None:
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        _write_standup_entity(graph, "2026-03-15", "none")
        _write_standup_entity(graph, "2026-03-16", "none")
        _write_standup_entity(graph, "2026-03-17", "none")
        _write_board(tmp_path)

        result = _run_check_drift(tmp_path)
        assert result.returncode == 0
        assert "DRIFT DETECTED" not in result.stdout

    def test_no_drift_when_delegations_field_is_empty(self, tmp_path: Path) -> None:
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        _write_standup_entity(graph, "2026-03-15", "")
        _write_standup_entity(graph, "2026-03-16", "")
        _write_standup_entity(graph, "2026-03-17", "")
        _write_board(tmp_path)

        result = _run_check_drift(tmp_path)
        assert result.returncode == 0
        assert "DRIFT DETECTED" not in result.stdout


# ---------------------------------------------------------------------------
# 5. Partial carry-over — delegation in only 2 of 3 standups
# ---------------------------------------------------------------------------


class TestNoDriftPartialCarryOver:
    def test_delegation_in_only_2_standups_not_flagged(self, tmp_path: Path) -> None:
        """A delegation that appears in only 2 of 3 standups must not be flagged."""
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        _write_standup_entity(graph, "2026-03-15", "→ Marketing: write launch tweet")
        _write_standup_entity(graph, "2026-03-16", "→ Marketing: write launch tweet")
        # Third standup has a different delegation
        _write_standup_entity(graph, "2026-03-17", "→ Marketing: update social bio")
        _write_board(tmp_path)

        result = _run_check_drift(tmp_path)
        assert result.returncode == 0
        assert "DRIFT DETECTED" not in result.stdout


# ---------------------------------------------------------------------------
# 6. Multiple delegations — only carry-overs flagged
# ---------------------------------------------------------------------------


class TestMultipleDelegations:
    def test_only_carry_over_delegation_is_flagged(self, tmp_path: Path) -> None:
        """When multiple delegations exist, only the carry-over one is flagged."""
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        # First standup: two delegations
        _write_standup_entity(
            graph,
            "2026-03-15",
            "→ Marketing: write launch tweet; → Accountant: review expenses",
        )
        # Second and third: only one delegation carries over
        _write_standup_entity(graph, "2026-03-16", "→ Marketing: write launch tweet")
        _write_standup_entity(graph, "2026-03-17", "→ Marketing: write launch tweet")
        _write_board(tmp_path)

        result = _run_check_drift(tmp_path)
        assert result.returncode == 1
        assert "DRIFT DETECTED" in result.stdout
        assert "write launch tweet" in result.stdout.lower()
        # The accountant delegation was not in all 3 — must not appear
        assert "review expenses" not in result.stdout.lower()


# ---------------------------------------------------------------------------
# 7. Metric entity — standup cycle counter present in knowledge graph
# ---------------------------------------------------------------------------


class TestStandupCycleCounterEntity:
    """Verify the initial metric:coo:standup-cycle-count entity is in the repo graph."""

    def test_cycle_counter_entity_present(self) -> None:
        graph_path = REPO_ROOT / "memory" / "knowledge-graph.jsonl"
        records = []
        for raw in graph_path.read_text(encoding="utf-8").splitlines():
            raw = raw.strip()
            if not raw:
                continue
            try:
                records.append(json.loads(raw))
            except json.JSONDecodeError:
                pass

        counter = next(
            (r for r in records if r.get("name") == "metric:coo:standup-cycle-count"),
            None,
        )
        assert counter is not None, (
            "metric:coo:standup-cycle-count entity not found in knowledge-graph.jsonl"
        )
        assert counter.get("entityType") == "metric"

    def test_cycle_counter_has_count_observation(self) -> None:
        graph_path = REPO_ROOT / "memory" / "knowledge-graph.jsonl"
        records = []
        for raw in graph_path.read_text(encoding="utf-8").splitlines():
            raw = raw.strip()
            if not raw:
                continue
            try:
                records.append(json.loads(raw))
            except json.JSONDecodeError:
                pass

        counter = next(
            (r for r in records if r.get("name") == "metric:coo:standup-cycle-count"),
            None,
        )
        assert counter is not None
        obs_text = " ".join(counter.get("observations", []))
        assert "count:" in obs_text, (
            "metric:coo:standup-cycle-count entity must have a 'count:' observation"
        )


# ---------------------------------------------------------------------------
# 8. Script argument handling
# ---------------------------------------------------------------------------


class TestScriptArguments:
    def test_unknown_argument_exits_2(self, tmp_path: Path) -> None:
        result = subprocess.run(
            ["bash", str(CHECK_DRIFT_SH), "--unknown-flag"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 2

    def test_missing_graph_file_exits_2(self, tmp_path: Path) -> None:
        """If knowledge-graph.jsonl is absent the script must exit 2."""
        (tmp_path / "BOARD.md").write_text(MINIMAL_BOARD_MD, encoding="utf-8")
        # memory/ dir exists but graph file does not
        (tmp_path / "memory").mkdir()

        result = _run_check_drift(tmp_path)
        assert result.returncode == 2

    def test_invalid_repo_root_exits_2(self) -> None:
        result = subprocess.run(
            ["bash", str(CHECK_DRIFT_SH), "--repo-root", "/nonexistent/path"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 2
