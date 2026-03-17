"""
Periodic prompt scheduler — knowledge-graph-backed.

Stores last-run dates as ``metric:prompt:<name>:last-run`` entities in
``memory/knowledge-graph.jsonl``.  The COO reads these entities during standup
and calls :func:`check_overdue` to surface any prompts that are past their
cadence deadline.

Four tracked prompts
--------------------
* ``weekly-review``        — 7-day cadence
* ``monthly-accounting``   — 30-day cadence
* ``quarterly-hst``        — 90-day cadence
* ``improver-monthly-cycle`` — 30-day cadence

Entity format (observations list)
----------------------------------
Each entity stores its state as ``"key: value"`` observation strings, e.g.::

    {"type": "entity",
     "name": "metric:prompt:weekly-review:last-run",
     "entityType": "metric",
     "observations": ["cadence_days: 7", "last_run: 2026-03-16",
                      "description: Weekly business review prompt"]}

Usage
-----
::

    from ops.scheduler import check_overdue

    overdue = check_overdue()          # uses default graph path
    for item in overdue:
        print(item["name"], "is overdue by", item["overdue_days"], "days")
"""

from __future__ import annotations

import json
import re
from datetime import date, timedelta
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

#: Canonical prompt registry: slug → cadence in days
PROMPTS: dict[str, int] = {
    "weekly-review": 7,
    "monthly-accounting": 30,
    "quarterly-hst": 90,
    "improver-monthly-cycle": 30,
}

def _default_graph_path() -> Path:
    """Return the default knowledge graph path rooted at the current working directory."""
    return Path.cwd() / "memory" / "knowledge-graph.jsonl"


def _resolve_graph_path(graph_path: Path | str | None) -> Path:
    """Resolve the caller-provided graph_path or fall back to the default."""
    return Path(graph_path) if graph_path is not None else _default_graph_path()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_ENTITY_NAME_PATTERN = re.compile(r"^metric:prompt:(.+):last-run$")


def _load_metric_entities(graph_path: Path) -> dict[str, dict[str, str]]:
    """Return ``{slug: {obs_key: obs_value, ...}}`` for every
    ``metric:prompt:*:last-run`` entity found in *graph_path*.

    Corrupt / schema-invalid lines are silently skipped (mirrors the
    behavior of ``KnowledgeGraphManager.loadGraph``).
    """
    metrics: dict[str, dict[str, str]] = {}

    if not graph_path.exists():
        return metrics

    for raw_line in graph_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            record: Any = json.loads(line)
        except json.JSONDecodeError:
            continue

        if not isinstance(record, dict):
            continue
        if record.get("type") != "entity":
            continue
        name = record.get("name", "")
        m = _ENTITY_NAME_PATTERN.match(name)
        if not m:
            continue

        slug = m.group(1)
        # Deduplicate: keep the first occurrence of each metric entity to align
        # with KnowledgeGraphManager's "first wins" behaviour.
        if slug in metrics:
            continue

        observations = record.get("observations")
        if not isinstance(observations, list):
            continue

        obs_map: dict[str, str] = {}
        for obs in observations:
            if isinstance(obs, str) and ": " in obs:
                key, _, value = obs.partition(": ")
                obs_map[key.strip()] = value.strip()

        metrics[slug] = obs_map

    return metrics


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def check_overdue(
    graph_path: Path | str | None = None,
    today: date | None = None,
) -> list[dict[str, Any]]:
    """Return a list of prompts that are past their cadence deadline.

    Parameters
    ----------
    graph_path:
        Path to ``knowledge-graph.jsonl``.  Defaults to the repo-level file.
    today:
        Reference date for the overdue calculation.  Defaults to
        ``date.today()``.  Pass an explicit date in tests.

    Returns
    -------
    list of dicts, each with keys:

    ``name``
        The entity name, e.g. ``"metric:prompt:weekly-review:last-run"``.
    ``slug``
        The short prompt slug, e.g. ``"weekly-review"``.
    ``cadence_days``
        The configured cadence (int).
    ``last_run``
        The last-run date as a :class:`datetime.date`, or ``None`` if the
        entity has never been recorded in the graph.
    ``due_date``
        The date on which the prompt became due.
    ``overdue_days``
        How many calendar days past due (always ≥ 1 for returned items).
    """
    resolved_path = _resolve_graph_path(graph_path)
    ref_date = today if today is not None else date.today()

    metrics = _load_metric_entities(resolved_path)
    overdue: list[dict[str, Any]] = []

    for slug, cadence_days in PROMPTS.items():
        obs = metrics.get(slug, {})
        last_run_str = obs.get("last_run")

        last_run: date | None = None
        if last_run_str:
            try:
                last_run = date.fromisoformat(last_run_str)
            except ValueError:
                last_run = None

        if last_run is None:
            # Never run — treat as maximally overdue (due from epoch)
            due_date = date(1970, 1, 1)
        else:
            due_date = last_run + timedelta(days=cadence_days)

        if ref_date >= due_date:
            overdue_days = (ref_date - due_date).days + 1
            overdue.append(
                {
                    "name": f"metric:prompt:{slug}:last-run",
                    "slug": slug,
                    "cadence_days": cadence_days,
                    "last_run": last_run,
                    "due_date": due_date,
                    "overdue_days": overdue_days,
                }
            )

    return overdue


def format_standup_block(
    graph_path: Path | str | None = None,
    today: date | None = None,
) -> str:
    """Return a human-readable standup summary of overdue periodic prompts.

    The COO agent can include this string in its standup output by calling::

        from ops.scheduler import format_standup_block
        print(format_standup_block())

    If all prompts are up to date, an empty string is returned.
    """
    overdue = check_overdue(graph_path=graph_path, today=today)
    if not overdue:
        return ""

    lines = ["⏰ **Overdue periodic prompts:**"]
    for item in overdue:
        last_str = item["last_run"].isoformat() if item["last_run"] else "never"
        lines.append(
            f"  - `{item['slug']}` — {item['overdue_days']} day(s) overdue "
            f"(cadence: {item['cadence_days']}d, last run: {last_str})"
        )
    return "\n".join(lines)
