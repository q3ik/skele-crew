"""
Tests for ops/scheduler.py — periodic prompt overdue detection.

All tests use tmp_path and an explicit `today` argument so the
real memory/knowledge-graph.jsonl is never read or modified.
"""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import pytest

from ops.scheduler import (
    PROMPTS,
    check_overdue,
    format_standup_block,
)
from ops.standup import build_coo_standup


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _write_metric_entity(
    graph_path: Path,
    slug: str,
    last_run: str | None,
    cadence_days: int | None = None,
) -> None:
    """Append a single metric entity line to *graph_path*."""
    cadence = cadence_days if cadence_days is not None else PROMPTS.get(slug, 7)
    observations = [f"cadence_days: {cadence}"]
    if last_run is not None:
        observations.append(f"last_run: {last_run}")
    record = {
        "type": "entity",
        "name": f"metric:prompt:{slug}:last-run",
        "entityType": "metric",
        "observations": observations,
    }
    with graph_path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record) + "\n")


# ---------------------------------------------------------------------------
# 1. PROMPTS registry
# ---------------------------------------------------------------------------

class TestPromptsRegistry:
    def test_four_prompts_defined(self) -> None:
        assert set(PROMPTS.keys()) == {
            "weekly-review",
            "monthly-accounting",
            "quarterly-hst",
            "improver-monthly-cycle",
        }

    def test_cadences_are_correct(self) -> None:
        assert PROMPTS["weekly-review"] == 7
        assert PROMPTS["monthly-accounting"] == 30
        assert PROMPTS["quarterly-hst"] == 90
        assert PROMPTS["improver-monthly-cycle"] == 30


# ---------------------------------------------------------------------------
# 2. check_overdue — happy path (all up to date)
# ---------------------------------------------------------------------------

class TestCheckOverdueUpToDate:
    def test_all_fresh_returns_empty(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        today = date(2026, 3, 16)

        # Last-run is today for each prompt — none are due yet
        for slug, cadence in PROMPTS.items():
            _write_metric_entity(graph, slug, today.isoformat(), cadence)

        result = check_overdue(graph_path=graph, today=today)
        assert result == [], f"Expected no overdue prompts, got {result}"

    def test_last_run_yesterday_within_cadence_not_overdue(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        today = date(2026, 3, 16)
        yesterday = today - timedelta(days=1)

        # weekly-review cadence is 7 days; ran yesterday → 6 days remaining
        _write_metric_entity(graph, "weekly-review", yesterday.isoformat(), 7)

        result = check_overdue(graph_path=graph, today=today)
        slugs = {r["slug"] for r in result}
        assert "weekly-review" not in slugs


# ---------------------------------------------------------------------------
# 3. check_overdue — overdue detection
# ---------------------------------------------------------------------------

class TestCheckOverdueDetection:
    def test_exactly_on_due_date_is_overdue(self, tmp_path: Path) -> None:
        """A prompt whose due_date == today is considered overdue (overdue_days=1)."""
        graph = tmp_path / "knowledge-graph.jsonl"
        today = date(2026, 3, 16)
        last_run = today - timedelta(days=7)  # due exactly today

        # Seed all four prompts so only weekly-review is on its due date;
        # the other three are up to date (ran today).
        _write_metric_entity(graph, "weekly-review", last_run.isoformat(), 7)
        _write_metric_entity(graph, "monthly-accounting", today.isoformat(), 30)
        _write_metric_entity(graph, "quarterly-hst", today.isoformat(), 90)
        _write_metric_entity(graph, "improver-monthly-cycle", today.isoformat(), 30)

        result = check_overdue(graph_path=graph, today=today)
        assert len(result) == 1
        item = result[0]
        assert item["slug"] == "weekly-review"
        assert item["overdue_days"] == 1
        assert item["due_date"] == today

    def test_8_days_overdue_flagged_correctly(self, tmp_path: Path) -> None:
        """Acceptance criteria: set weekly-review 8 days past its due date."""
        graph = tmp_path / "knowledge-graph.jsonl"
        today = date(2026, 3, 16)
        # cadence=7, overdue by 8 days → last_run must be 7+8-1=14 days ago
        # due_date = last_run + 7; today - due_date = 8 → overdue_days = 9? Let's check:
        # overdue_days = (today - due_date).days + 1
        # We want overdue_days = 8 → (today - due_date).days = 7
        # due_date = today - 7 = 2026-03-09
        # last_run = due_date - 7 = 2026-03-02
        last_run = today - timedelta(days=14)

        _write_metric_entity(graph, "weekly-review", last_run.isoformat(), 7)

        result = check_overdue(graph_path=graph, today=today)
        slugs = {r["slug"] for r in result}
        assert "weekly-review" in slugs

        item = next(r for r in result if r["slug"] == "weekly-review")
        assert item["overdue_days"] >= 8, (
            f"Expected at least 8 overdue days, got {item['overdue_days']}"
        )

    def test_overdue_days_count_is_accurate(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        today = date(2026, 3, 16)
        # monthly-accounting: cadence 30 days
        # last_run = today - 38 days → due_date = today - 8 days → overdue_days = 9
        last_run = today - timedelta(days=38)
        _write_metric_entity(graph, "monthly-accounting", last_run.isoformat(), 30)

        result = check_overdue(graph_path=graph, today=today)
        item = next(r for r in result if r["slug"] == "monthly-accounting")
        assert item["overdue_days"] == 9

    def test_all_four_overdue_at_once(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        today = date(2026, 3, 16)

        # Push all last-run dates far into the past
        _write_metric_entity(graph, "weekly-review", "2026-01-01", 7)
        _write_metric_entity(graph, "monthly-accounting", "2026-01-01", 30)
        _write_metric_entity(graph, "quarterly-hst", "2025-01-01", 90)
        _write_metric_entity(graph, "improver-monthly-cycle", "2026-01-01", 30)

        result = check_overdue(graph_path=graph, today=today)
        slugs = {r["slug"] for r in result}
        assert slugs == {
            "weekly-review",
            "monthly-accounting",
            "quarterly-hst",
            "improver-monthly-cycle",
        }

    def test_only_overdue_prompts_returned_when_mixed(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        today = date(2026, 3, 16)

        # weekly-review: up to date (ran today)
        _write_metric_entity(graph, "weekly-review", today.isoformat(), 7)
        # monthly-accounting: overdue (ran 40 days ago)
        _write_metric_entity(graph, "monthly-accounting", (today - timedelta(days=40)).isoformat(), 30)
        # quarterly-hst: up to date (ran 1 day ago)
        _write_metric_entity(graph, "quarterly-hst", (today - timedelta(days=1)).isoformat(), 90)
        # improver-monthly-cycle: up to date (ran today)
        _write_metric_entity(graph, "improver-monthly-cycle", today.isoformat(), 30)

        result = check_overdue(graph_path=graph, today=today)
        assert len(result) == 1
        assert result[0]["slug"] == "monthly-accounting"

    def test_improver_monthly_cycle_overdue_detection(self, tmp_path: Path) -> None:
        """improver-monthly-cycle is tracked and surfaces as overdue when past 30 days."""
        graph = tmp_path / "knowledge-graph.jsonl"
        today = date(2026, 3, 16)
        last_run = today - timedelta(days=35)  # 5 days overdue

        _write_metric_entity(graph, "improver-monthly-cycle", last_run.isoformat(), 30)

        result = check_overdue(graph_path=graph, today=today)
        slugs = {r["slug"] for r in result}
        assert "improver-monthly-cycle" in slugs

        item = next(r for r in result if r["slug"] == "improver-monthly-cycle")
        assert item["cadence_days"] == 30
        assert item["overdue_days"] == 6


# ---------------------------------------------------------------------------
# 4. check_overdue — missing / corrupt entities
# ---------------------------------------------------------------------------

class TestCheckOverdueMissingEntities:
    def test_nonexistent_graph_flags_all_as_overdue(self, tmp_path: Path) -> None:
        """If the graph file does not exist, all prompts have never run → all overdue."""
        graph = tmp_path / "does-not-exist.jsonl"
        result = check_overdue(graph_path=graph, today=date(2026, 3, 16))
        slugs = {r["slug"] for r in result}
        assert slugs == set(PROMPTS.keys())

    def test_missing_entity_for_one_slug_flags_it_overdue(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        today = date(2026, 3, 16)

        # Only seed weekly-review (up to date); others absent → overdue
        _write_metric_entity(graph, "weekly-review", today.isoformat(), 7)

        result = check_overdue(graph_path=graph, today=today)
        slugs = {r["slug"] for r in result}
        assert "weekly-review" not in slugs
        assert "monthly-accounting" in slugs
        assert "quarterly-hst" in slugs
        assert "improver-monthly-cycle" in slugs

    def test_entity_with_no_last_run_observation_is_overdue(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        today = date(2026, 3, 16)

        # Write entity without last_run observation
        _write_metric_entity(graph, "weekly-review", last_run=None, cadence_days=7)

        result = check_overdue(graph_path=graph, today=today)
        slugs = {r["slug"] for r in result}
        assert "weekly-review" in slugs

    def test_entity_with_invalid_date_is_overdue(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        today = date(2026, 3, 16)

        record = {
            "type": "entity",
            "name": "metric:prompt:weekly-review:last-run",
            "entityType": "metric",
            "observations": ["cadence_days: 7", "last_run: NOT-A-DATE"],
        }
        graph.write_text(json.dumps(record) + "\n", encoding="utf-8")

        result = check_overdue(graph_path=graph, today=today)
        slugs = {r["slug"] for r in result}
        assert "weekly-review" in slugs

    def test_corrupt_lines_skipped_valid_entity_still_checked(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        today = date(2026, 3, 16)

        # Mix a corrupt line with a valid up-to-date metric entity
        graph.write_text(
            "THIS IS NOT JSON\n"
            + json.dumps({
                "type": "entity",
                "name": "metric:prompt:weekly-review:last-run",
                "entityType": "metric",
                "observations": ["cadence_days: 7", f"last_run: {today.isoformat()}"],
            })
            + "\n",
            encoding="utf-8",
        )

        result = check_overdue(graph_path=graph, today=today)
        slugs = {r["slug"] for r in result}
        assert "weekly-review" not in slugs  # valid entity read correctly


class TestCheckOverduePathResolution:
    def test_default_path_uses_cwd_memory_dir(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """Regression: ensure default graph path resolves from CWD, matching MCP memory server."""
        new_cwd = tmp_path / "repo-root"
        memory_dir = new_cwd / "memory"
        memory_dir.mkdir(parents=True)
        graph = memory_dir / "knowledge-graph.jsonl"

        today = date(2026, 3, 16)
        _write_metric_entity(graph, "weekly-review", (today - timedelta(days=14)).isoformat(), 7)

        monkeypatch.chdir(new_cwd)

        result = check_overdue(today=today)
        slugs = {r["slug"] for r in result}
        assert "weekly-review" in slugs

    def test_duplicate_metric_entities_keep_first_occurrence(self, tmp_path: Path) -> None:
        """Aligns with KnowledgeGraphManager dedupe semantics (first occurrence wins)."""
        graph = tmp_path / "knowledge-graph.jsonl"
        today = date(2026, 3, 16)

        # First line: up to date (should win)
        _write_metric_entity(graph, "weekly-review", today.isoformat(), 7)
        # Duplicate later line: stale/overdue — should be ignored
        _write_metric_entity(graph, "weekly-review", "2026-01-01", 7)

        result = check_overdue(graph_path=graph, today=today)
        slugs = {r["slug"] for r in result}
        assert "weekly-review" not in slugs, f"Duplicate line should be ignored, got {result}"


# ---------------------------------------------------------------------------
# 5. format_standup_block
# ---------------------------------------------------------------------------

class TestFormatStandupBlock:
    def test_empty_string_when_nothing_overdue(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        today = date(2026, 3, 16)
        for slug, cadence in PROMPTS.items():
            _write_metric_entity(graph, slug, today.isoformat(), cadence)

        result = format_standup_block(graph_path=graph, today=today)
        assert result == ""

    def test_block_contains_overdue_slug(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        today = date(2026, 3, 16)
        _write_metric_entity(graph, "weekly-review", "2026-01-01", 7)

        result = format_standup_block(graph_path=graph, today=today)
        assert "weekly-review" in result
        assert "overdue" in result.lower()

    def test_block_lists_all_overdue_prompts(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        today = date(2026, 3, 16)
        _write_metric_entity(graph, "weekly-review", "2026-01-01", 7)
        _write_metric_entity(graph, "monthly-accounting", "2026-01-01", 30)
        _write_metric_entity(graph, "quarterly-hst", "2025-01-01", 90)
        _write_metric_entity(graph, "improver-monthly-cycle", "2026-01-01", 30)

        result = format_standup_block(graph_path=graph, today=today)
        assert "weekly-review" in result
        assert "monthly-accounting" in result
        assert "quarterly-hst" in result
        assert "improver-monthly-cycle" in result


class TestBuildCooStandup:
    def test_standup_includes_scheduler_block_when_overdue(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        today = date(2026, 3, 16)
        # weekly-review: 8 days overdue acceptance criterion
        _write_metric_entity(graph, "weekly-review", (today - timedelta(days=14)).isoformat(), 7)

        sections = build_coo_standup(graph_path=graph, today=today)
        assert sections, "Expected scheduler block to be included"
        assert any("weekly-review" in section for section in sections)
        assert any("overdue" in section.lower() for section in sections)

    def test_standup_omits_scheduler_block_when_clear(self, tmp_path: Path) -> None:
        graph = tmp_path / "knowledge-graph.jsonl"
        today = date(2026, 3, 16)
        for slug, cadence in PROMPTS.items():
            _write_metric_entity(graph, slug, today.isoformat(), cadence)

        sections = build_coo_standup(graph_path=graph, today=today)
        assert sections == []
