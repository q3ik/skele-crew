"""
COO (Chief Operating Officer) standup helpers.

This module keeps the standup composition logic close to other operational
helpers.  The key integration is the periodic prompt scheduler: overdue
prompts must show up in the COO's standup output.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

from ops.scheduler import format_standup_block


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
