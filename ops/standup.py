"""
COO (Chief Operating Officer) standup helpers.

This module keeps the standup composition logic close to other operational
helpers.  The key integration is the periodic prompt scheduler: overdue
prompts must show up in the COO's standup output.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any

from ops.scheduler import _resolve_graph_path, format_standup_block


def verify_standup_entity(
    graph_path: Path | str | None = None,
    today: date | None = None,
) -> bool:
    """Return ``True`` if a standup entity for *today* exists in the knowledge graph.

    Used as a post-standup assertion to confirm that the COO wrote the expected
    ``standup:YYYY-MM-DD`` entity to ``memory/knowledge-graph.jsonl``.

    Parameters
    ----------
    graph_path:
        Path to ``knowledge-graph.jsonl``.  Defaults to the repo-level file.
    today:
        Reference date.  Defaults to ``date.today()``.

    Returns
    -------
    bool
        ``True`` if a ``standup:YYYY-MM-DD`` entity for *today* is present;
        ``False`` otherwise.
    """
    resolved_path = _resolve_graph_path(graph_path)
    ref_date = today if today is not None else date.today()
    entity_name = f"standup:{ref_date.isoformat()}"

    if not resolved_path.exists():
        return False

    with resolved_path.open(encoding="utf-8") as fh:
        for raw_line in fh:
            line = raw_line.strip()
            if not line:
                continue
            try:
                record: Any = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(record, dict) and record.get("name") == entity_name:
                return True

    return False


def build_coo_standup(graph_path: Path | str | None = None, today: date | None = None) -> list[str]:
    """Return standup sections, including the scheduler block when overdue.

    The COO agent can join these sections with blank lines when rendering the
    final standup message.

    Parameters
    ----------
    graph_path:
        Optional path to ``knowledge-graph.jsonl``; defaults to the current
        working directory's ``memory/`` folder.
    today:
        Optional reference date for overdue calculations; defaults to
        ``date.today()`` when omitted.

    Returns
    -------
    list[str]
        Standup sections to render; empty when nothing is overdue so the caller
        can skip the block entirely.
    """
    sections: list[str] = []

    scheduler_block = format_standup_block(graph_path=graph_path, today=today)
    if scheduler_block:
        sections.append(scheduler_block)

    return sections
