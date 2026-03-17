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
    board_overdue: str = "",
) -> None:
    """Append a standup entity to *graph_path*.

    Parameters
    ----------
    graph_path:
        Path to the knowledge graph JSONL file.
    date_str:
        ISO date string, e.g. ``"2026-03-15"``.
    delegations:
        Raw delegation value, e.g. ``"→ Marketing: write launch tweet"``.
        Defaults to ``"none"`` (no delegations).
    board_overdue:
        Semicolon-separated list of overdue task names to embed as a
        ``board-overdue:`` observation (BOARD.md snapshot).  Omit or pass
        ``""`` to skip the observation (simulates older standup entities
        that pre-date the board snapshot feature).
    """
    observations: list[str] = [
        "errors: 0",
        "overdue-tasks: 0",
    ]
    if board_overdue:
        observations.append(f"board-overdue: {board_overdue}")
    observations += [
        f"delegations: {delegations}",
        "priority-1: none",
    ]
    record: dict[str, Any] = {
        "type": "entity",
        "name": f"standup:{date_str}",
        "entityType": "standup",
        "observations": observations,
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
        """Output line must match the canonical DRIFT DETECTED format — no quotes
        around the action, agent name in original case."""
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        _write_standup_entity(graph, "2026-03-15", "→ Marketing: write launch tweet")
        _write_standup_entity(graph, "2026-03-16", "→ Marketing: write launch tweet")
        _write_standup_entity(graph, "2026-03-17", "→ Marketing: write launch tweet")
        _write_board(tmp_path)

        result = _run_check_drift(tmp_path)
        assert "DRIFT DETECTED" in result.stdout

        # Bug 3 fix: agent name preserved in original case (not lowercased)
        assert "Marketing" in result.stdout

        # Bug 1 fix: action must NOT be wrapped in single or double quotes
        drift_line = next(
            line for line in result.stdout.splitlines() if "DRIFT DETECTED" in line
        )
        assert "'write launch tweet'" not in drift_line, (
            "Action should not be surrounded by single quotes"
        )
        assert '"write launch tweet"' not in drift_line, (
            "Action should not be surrounded by double quotes"
        )
        assert "write launch tweet" in drift_line.lower()

        # Date of the oldest standup
        assert "2026-03-15" in result.stdout

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

    def test_cycle_counter_has_cycle_count_observation(self) -> None:
        """Bug 6 fix: observation key must be 'cycle-count:' matching the entity name."""
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
        observations = counter.get("observations", [])
        assert any(obs.startswith("cycle-count:") for obs in observations), (
            "metric:coo:standup-cycle-count must have a 'cycle-count:' observation "
            f"(found: {observations})"
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


# ---------------------------------------------------------------------------
# 9. BOARD.md prerequisite enforcement (Bug 4)
# ---------------------------------------------------------------------------


class TestBoardMDPrereq:
    def test_missing_board_file_exits_2(self, tmp_path: Path) -> None:
        """Bug 4 fix: BOARD.md must exist; missing file exits with code 2."""
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        graph.write_text("", encoding="utf-8")
        # No BOARD.md created

        result = _run_check_drift(tmp_path)
        assert result.returncode == 2, (
            f"Expected exit 2 when BOARD.md is absent, got {result.returncode}.\n"
            f"stderr: {result.stderr}"
        )
        assert "BOARD.md" in result.stderr

    def test_board_file_present_allows_run(self, tmp_path: Path) -> None:
        """When BOARD.md exists and there are <3 standups, script exits 0 (no drift)."""
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        graph.write_text("", encoding="utf-8")
        _write_board(tmp_path)  # create BOARD.md

        result = _run_check_drift(tmp_path)
        assert result.returncode == 0


# ---------------------------------------------------------------------------
# 10. Board snapshot comparison (Bug 2)
# ---------------------------------------------------------------------------


class TestBoardSnapshotComparison:
    """Tests for the board-overdue snapshot comparison drift signal.

    When ALL 3 standup entities include a ``board-overdue:`` observation and the
    same task appears in all three, drift is detected even if there are no
    delegation carry-overs.
    """

    def test_board_snapshot_drift_detected_exit_code_1(self, tmp_path: Path) -> None:
        """Task overdue in all 3 standup board snapshots → exit 1."""
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        _write_standup_entity(
            graph, "2026-03-15", delegations="none", board_overdue="implement login"
        )
        _write_standup_entity(
            graph, "2026-03-16", delegations="none", board_overdue="implement login"
        )
        _write_standup_entity(
            graph, "2026-03-17", delegations="none", board_overdue="implement login"
        )
        _write_board(tmp_path)  # task NOT in completed section

        result = _run_check_drift(tmp_path)
        assert result.returncode == 1, (
            f"Expected exit 1 (board snapshot drift), got {result.returncode}.\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )

    def test_board_snapshot_drift_output_contains_task(self, tmp_path: Path) -> None:
        """DRIFT DETECTED line must mention the stale board task."""
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        _write_standup_entity(
            graph, "2026-03-15", delegations="none", board_overdue="implement login"
        )
        _write_standup_entity(
            graph, "2026-03-16", delegations="none", board_overdue="implement login"
        )
        _write_standup_entity(
            graph, "2026-03-17", delegations="none", board_overdue="implement login"
        )
        _write_board(tmp_path)

        result = _run_check_drift(tmp_path)
        assert "DRIFT DETECTED" in result.stdout
        assert "implement login" in result.stdout.lower()
        assert "2026-03-15" in result.stdout

    def test_board_snapshot_no_drift_if_task_in_completed(
        self, tmp_path: Path
    ) -> None:
        """Task in board-overdue of all 3 standups but completed in BOARD.md → no drift."""
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        _write_standup_entity(
            graph, "2026-03-15", delegations="none", board_overdue="implement login"
        )
        _write_standup_entity(
            graph, "2026-03-16", delegations="none", board_overdue="implement login"
        )
        _write_standup_entity(
            graph, "2026-03-17", delegations="none", board_overdue="implement login"
        )
        _write_board(tmp_path, completed_tasks=["implement login"])

        result = _run_check_drift(tmp_path)
        assert result.returncode == 0
        assert "DRIFT DETECTED" not in result.stdout

    def test_board_snapshot_no_drift_if_task_only_in_2_standups(
        self, tmp_path: Path
    ) -> None:
        """Task in board-overdue of only 2 standups → not a 3-cycle carry-over."""
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        _write_standup_entity(
            graph, "2026-03-15", delegations="none", board_overdue="implement login"
        )
        _write_standup_entity(
            graph, "2026-03-16", delegations="none", board_overdue="implement login"
        )
        # Third standup has a different task
        _write_standup_entity(
            graph, "2026-03-17", delegations="none", board_overdue="fix pricing page"
        )
        _write_board(tmp_path)

        result = _run_check_drift(tmp_path)
        assert result.returncode == 0
        assert "DRIFT DETECTED" not in result.stdout

    def test_board_snapshot_skipped_when_not_all_standups_have_data(
        self, tmp_path: Path
    ) -> None:
        """If only some standups have board-overdue data, the snapshot comparison
        is skipped gracefully (no false positives)."""
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        # Only 2 of 3 standups have board-overdue observations
        _write_standup_entity(
            graph, "2026-03-15", delegations="none", board_overdue="implement login"
        )
        _write_standup_entity(
            graph, "2026-03-16", delegations="none", board_overdue="implement login"
        )
        _write_standup_entity(
            graph, "2026-03-17", delegations="none"  # no board_overdue
        )
        _write_board(tmp_path)

        result = _run_check_drift(tmp_path)
        assert result.returncode == 0
        assert "DRIFT DETECTED" not in result.stdout

    def test_board_snapshot_lesson_entity_written(self, tmp_path: Path) -> None:
        """Drift via board snapshot must write a lesson entity."""
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        _write_standup_entity(
            graph, "2026-03-15", delegations="none", board_overdue="implement login"
        )
        _write_standup_entity(
            graph, "2026-03-16", delegations="none", board_overdue="implement login"
        )
        _write_standup_entity(
            graph, "2026-03-17", delegations="none", board_overdue="implement login"
        )
        _write_board(tmp_path)

        _run_check_drift(tmp_path)

        lessons = _get_drift_lessons(tmp_path)
        assert lessons, "Expected a drift lesson entity from board snapshot comparison"
        obs_text = " ".join(lessons[-1].get("observations", []))
        assert "missed-deadline" in obs_text
        assert "implement login" in obs_text.lower()


# ---------------------------------------------------------------------------
# 11. Delegation format edge cases (Bug 3)
# ---------------------------------------------------------------------------


class TestDelegationFormatEdgeCases:
    def test_markdown_list_prefix_stripped(self, tmp_path: Path) -> None:
        """Bug 3 fix: delegations stored with '- → Agent: task' list prefix
        must be parsed correctly."""
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        # Simulate COO writing markdown-style delegation list
        _write_standup_entity(
            graph, "2026-03-15", "- → Marketing: write launch tweet"
        )
        _write_standup_entity(
            graph, "2026-03-16", "- → Marketing: write launch tweet"
        )
        _write_standup_entity(
            graph, "2026-03-17", "- → Marketing: write launch tweet"
        )
        _write_board(tmp_path)

        result = _run_check_drift(tmp_path)
        assert result.returncode == 1
        assert "DRIFT DETECTED" in result.stdout
        assert "Marketing" in result.stdout
        assert "write launch tweet" in result.stdout.lower()

    def test_agent_name_preserved_in_original_case(self, tmp_path: Path) -> None:
        """Bug 3 fix: agent name in drift report must match original capitalisation."""
        memory = tmp_path / "memory"
        memory.mkdir()
        graph = memory / "knowledge-graph.jsonl"
        _write_standup_entity(graph, "2026-03-15", "→ Accountant: file HST return")
        _write_standup_entity(graph, "2026-03-16", "→ Accountant: file HST return")
        _write_standup_entity(graph, "2026-03-17", "→ Accountant: file HST return")
        _write_board(tmp_path)

        result = _run_check_drift(tmp_path)
        assert "Accountant" in result.stdout, (
            "Agent name 'Accountant' must appear with original capitalisation; "
            f"got: {result.stdout!r}"
        )

