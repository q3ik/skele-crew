#!/usr/bin/env bash
# check-drift.sh
#
# COO coach check — drift detection (run every 3 standup cycles).
#
# Reads the last 3 standup:* entities from knowledge-graph.jsonl and checks
# two drift signals:
#
#   1. Delegation carry-over — the same delegation appears in ALL 3 standups'
#      "delegations:" observations without appearing in BOARD.md's Completed
#      section.
#
#   2. Board snapshot comparison — a task appears in ALL 3 standups'
#      "board-overdue:" observations (BOARD.md state snapshots recorded at
#      each standup) without appearing in BOARD.md's Completed section.
#
# When drift is found the script prints a DRIFT DETECTED line for each item,
# appends a lesson entity to knowledge-graph.jsonl via atomic write, and exits
# with status 1.  When no drift is found it exits with 0.
#
# Intended to be called by the COO agent on every cycle where:
#   metric:coo:standup-cycle-count  cycle-count % 3 == 0
#
# Usage:
#   ./scripts/check-drift.sh [--repo-root <path>]
#
# Options:
#   --repo-root <path>   Root of the repository (default: parent of this
#                        script's directory, i.e. the repo root)
#
# Exit codes:
#   0  No drift detected (or fewer than 3 standup entities found)
#   1  Drift detected — DRIFT DETECTED lines printed to stdout; lesson entity
#      appended to knowledge-graph.jsonl
#   2  Usage / argument / prerequisite error

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve repo root
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/.."

while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo-root)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --repo-root requires a path argument" >&2
                exit 2
            fi
            if [[ ! -d "$2" ]]; then
                echo "Error: --repo-root path not found: $2" >&2
                exit 2
            fi
            REPO_ROOT="$2"
            shift 2
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 2
            ;;
    esac
done

GRAPH_FILE="$REPO_ROOT/memory/knowledge-graph.jsonl"
BOARD_FILE="$REPO_ROOT/BOARD.md"
GRAPH_FILE="$REPO_ROOT/memory/knowledge-graph.jsonl"
BOARD_FILE="$REPO_ROOT/BOARD.md"

if [[ ! -f "$GRAPH_FILE" ]]; then
    echo "Error: knowledge-graph.jsonl not found at $GRAPH_FILE" >&2
    exit 2
fi

# Bug 4: BOARD.md is a required prerequisite — enforce it explicitly.
if [[ ! -f "$BOARD_FILE" ]]; then
    echo "Error: BOARD.md not found at $BOARD_FILE" >&2
    exit 2
fi

if ! command -v python3 >/dev/null 2>&1; then
    echo "Error: python3 is required but not found in PATH." >&2
    echo "       Install Python 3 (https://www.python.org/downloads/) and ensure it is on your PATH." >&2
    exit 2
fi

# ---------------------------------------------------------------------------
# Run drift detection via inline Python (robust JSON + date parsing).
#
# The Python script:
#   1. Parses the last 3 standup:YYYY-MM-DD entities (by date order).
#   2. Extracts "delegations:" and "board-overdue:" observations — preserving
#      original case for the report while using lowercase for comparison.
#   3. Delegation carry-over: tokens present in ALL 3 standups' delegations.
#   4. Board snapshot comparison: tasks in ALL 3 standups' board-overdue lists.
#   5. Excludes items whose task description appears in BOARD.md's Completed
#      section (resolved tasks are not flagged as drift).
#   6. For unresolved drift items:
#      a. Prints "DRIFT DETECTED — Agent committed to action on date, no output found"
#         (no repr() quoting — plain text only).
#      b. Atomically appends a lesson entity to knowledge-graph.jsonl.
#   7. Exits with code 1 if any drift was found, 0 otherwise.
# ---------------------------------------------------------------------------
set +e
DRIFT_OUTPUT="$(python3 - "$GRAPH_FILE" "$BOARD_FILE" <<'PYEOF'
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from datetime import date
from pathlib import Path

graph_file = Path(sys.argv[1])
board_file = Path(sys.argv[2])

# ---------------------------------------------------------------------------
# 1. Parse standup entities — preserve original case; capture board-overdue
# ---------------------------------------------------------------------------
_STANDUP_RE = re.compile(r"^standup:(\d{4}-\d{2}-\d{2})$")

# date_str -> (delegations_raw, board_overdue_raw) — original case, first-wins
standups: dict[str, tuple[str, str]] = {}

for raw_line in graph_file.read_text(encoding="utf-8").splitlines():
    line = raw_line.strip()
    if not line:
        continue
    try:
        record = json.loads(line)
    except json.JSONDecodeError:
        continue
    if not isinstance(record, dict):
        continue
    name = record.get("name", "")
    m = _STANDUP_RE.match(name)
    if not m:
        continue
    date_str = m.group(1)
    obs = record.get("observations", [])
    delegations_value = ""
    board_overdue_value = ""
    for o in obs:
        if isinstance(o, str):
            if o.startswith("delegations: "):
                delegations_value = o[len("delegations: "):]
            elif o.startswith("board-overdue: "):
                board_overdue_value = o[len("board-overdue: "):]
    # First occurrence of each date wins (aligns with KnowledgeGraphManager semantics)
    if date_str not in standups:
        standups[date_str] = (delegations_value, board_overdue_value)

# Need at least 3 standups to perform a meaningful coach check
sorted_dates = sorted(standups.keys())
if len(sorted_dates) < 3:
    sys.exit(0)

last3_dates = sorted_dates[-3:]

# ---------------------------------------------------------------------------
# 2. Delegation carry-over — tokens common to ALL 3 standups
# ---------------------------------------------------------------------------
_PLACEHOLDER_RE = re.compile(r"^(none|n/a|\[\]|\[list\])$", re.IGNORECASE)

# Bug 3 fix: use [^:\s]+ (stops explicitly at colon or whitespace) instead of \S+
# to avoid backtracking ambiguity — \S+ would greedily consume the colon, forcing
# the regex engine to backtrack, which produced incorrect agent/task splits.
_DELEGATION_RE = re.compile(r"(?:→|->)\s*([^:\s]+):\s*(.+)")

# Bug 3 fix: strip optional markdown list prefix (- or * before the arrow)
# so delegations stored as "- → Agent: task" are parsed correctly.
_LIST_PREFIX_RE = re.compile(r"^[-*•]\s+")


def _split_tokens(raw: str) -> list[str]:
    """Split raw delegation value into tokens, stripping markdown list prefixes."""
    if not raw or _PLACEHOLDER_RE.match(raw.strip()):
        return []
    result: list[str] = []
    for part in re.split(r"[;\n]", raw):
        part = _LIST_PREFIX_RE.sub("", part.strip())
        if part:
            result.append(part)
    return result


# Build lowercase→original mapping to preserve agent/task case in the report.
lower_to_original: dict[str, str] = {}
for d in last3_dates:
    for tok in _split_tokens(standups[d][0]):
        lower_to_original[tok.lower()] = tok

delegation_sets = [
    {t.lower() for t in _split_tokens(standups[d][0])} for d in last3_dates
]
common_delegations: set[str] = (
    delegation_sets[0] & delegation_sets[1] & delegation_sets[2]
)

# ---------------------------------------------------------------------------
# 2b. Board snapshot comparison — tasks overdue in ALL 3 board-overdue snapshots
# ---------------------------------------------------------------------------

def _split_board_tasks(raw: str) -> set[str]:
    """Return lowercased overdue task names from a board-overdue observation."""
    if not raw or _PLACEHOLDER_RE.match(raw.strip()):
        return set()
    return {t.strip().lower() for t in re.split(r"[;\n]", raw) if t.strip()}


board_sets = [_split_board_tasks(standups[d][1]) for d in last3_dates]
# Only activate board snapshot comparison when ALL 3 standups recorded
# board-overdue data; fall back to delegation-only when snapshots are absent.
common_board_overdue: set[str] = (
    board_sets[0] & board_sets[1] & board_sets[2]
    if all(board_sets)
    else set()
)

if not common_delegations and not common_board_overdue:
    sys.exit(0)

# ---------------------------------------------------------------------------
# 3. Load BOARD.md completed section (current state for resolution check)
# ---------------------------------------------------------------------------
content = board_file.read_text(encoding="utf-8")
completed_text = ""
m = re.search(
    r"##[^\n]*Completed[^\n]*\n(.*?)(?=\n##|\Z)",
    content,
    re.DOTALL,
)
if m:
    completed_text = m.group(1).lower()

# ---------------------------------------------------------------------------
# 4. Collect drifted items
# ---------------------------------------------------------------------------
today_str = date.today().isoformat()
committed_date = last3_dates[0]  # oldest of the 3 cycles

drifted: list[tuple[str, str]] = []  # [(agent, task_desc)]

# --- Delegation carry-over ---
for delegation_lower in sorted(common_delegations):
    original = lower_to_original.get(delegation_lower, delegation_lower)
    normalized = _LIST_PREFIX_RE.sub("", original.strip())
    task_match = _DELEGATION_RE.match(normalized)
    if task_match:
        agent = task_match.group(1)          # original case preserved
        task_desc = task_match.group(2).strip()
    else:
        agent = "unknown"
        task_desc = normalized

    # Task resolved if its description appears in the BOARD.md completed section
    if task_desc and task_desc.lower() in completed_text:
        continue

    drifted.append((agent, task_desc))

# --- Board snapshot comparison ---
seen_lower = {t.lower() for _, t in drifted}
for task_lower in sorted(common_board_overdue):
    if task_lower in completed_text:
        continue  # task was completed
    if task_lower in seen_lower:
        continue  # already flagged via delegation carry-over
    drifted.append(("board", task_lower))

if not drifted:
    sys.exit(0)

# ---------------------------------------------------------------------------
# 5. Print drift report
# Bug 1 fix: use plain {task_desc} — no repr() quoting around the action.
# ---------------------------------------------------------------------------
for agent, task_desc in drifted:
    print(
        f"DRIFT DETECTED — {agent} committed to {task_desc}"
        f" on {committed_date}, no output found"
    )

# ---------------------------------------------------------------------------
# 6. Append lesson entities — ATOMIC WRITE (tempfile + os.replace)
# Bug 5 fix: bare open("a") is not atomic; use mkstemp + os.replace so that
# an interrupted write never leaves knowledge-graph.jsonl in a corrupt state.
# ---------------------------------------------------------------------------
new_records: list[str] = []
for agent, task_desc in drifted:
    slug = re.sub(r"[^a-z0-9]+", "-", task_desc.lower())[:40].strip("-")
    lesson_name = f"lesson:{today_str}:drift-{agent.lower()}-{slug}"
    lesson = {
        "type": "entity",
        "name": lesson_name,
        "entityType": "lesson",
        "observations": [
            "category: missed-deadline",
            f"agent: {agent}",
            (
                f"summary: {agent} committed to '{task_desc}' on {committed_date},"
                " no output found after 3 standup cycles"
            ),
            "action: escalated to human — coach check flagged carry-over delegation",
        ],
    }
    new_records.append(json.dumps(lesson))

existing = graph_file.read_text(encoding="utf-8")
fd, tmp_path = tempfile.mkstemp(
    dir=graph_file.parent, prefix="knowledge-graph-", suffix=".tmp"
)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(existing)
        if existing and not existing.endswith("\n"):
            fh.write("\n")
        for rec in new_records:
            fh.write(rec + "\n")
    os.replace(tmp_path, str(graph_file))
except Exception:
    try:
        os.unlink(tmp_path)
    except OSError:
        pass
    raise

sys.exit(1)
PYEOF
)"
DRIFT_EXIT=$?
set -e

if [[ $DRIFT_EXIT -eq 0 ]]; then
    echo "Coach check complete — no drift detected."
    exit 0
elif [[ $DRIFT_EXIT -eq 1 ]]; then
    echo "$DRIFT_OUTPUT"
    exit 1
else
    echo "Error: drift detection script failed with exit code $DRIFT_EXIT" >&2
    exit 2
fi
