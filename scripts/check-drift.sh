#!/usr/bin/env bash
# check-drift.sh
#
# COO coach check — drift detection (run every 3 standup cycles).
#
# Reads the last 3 standup:* entities from knowledge-graph.jsonl, extracts
# delegation lines, cross-references them against BOARD.md completed tasks,
# and prints DRIFT DETECTED for any unresolved delegation found in all 3
# standups.  When drift is found the script also appends a lesson entity to
# knowledge-graph.jsonl and exits with status 1.  When no drift is found it
# exits with 0.
#
# Intended to be called by the COO agent on every cycle where:
#   metric:coo:standup-cycle-count % 3 == 0
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

REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"
GRAPH_FILE="$REPO_ROOT/memory/knowledge-graph.jsonl"
BOARD_FILE="$REPO_ROOT/BOARD.md"

if [[ ! -f "$GRAPH_FILE" ]]; then
    echo "Error: knowledge-graph.jsonl not found at $GRAPH_FILE" >&2
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
#   2. Extracts delegation tokens from each standup's "delegations:" observation.
#   3. Finds tokens that appear in ALL 3 standups (carry-over delegations).
#   4. Checks whether each carry-over task description is mentioned in the
#      "Completed" section of BOARD.md.
#   5. For unresolved carry-over delegations:
#      a. Prints "DRIFT DETECTED — ..." line to stdout.
#      b. Appends a lesson entity to knowledge-graph.jsonl.
#   6. Exits with code 1 if any drift was found, 0 otherwise.
# ---------------------------------------------------------------------------
set +e
DRIFT_OUTPUT="$(python3 - "$GRAPH_FILE" "$BOARD_FILE" <<'PYEOF'
from __future__ import annotations

import json
import re
import sys
from datetime import date
from pathlib import Path

graph_file = Path(sys.argv[1])
board_file = Path(sys.argv[2])

# ---------------------------------------------------------------------------
# 1. Parse standup entities
# ---------------------------------------------------------------------------
_STANDUP_RE = re.compile(r"^standup:(\d{4}-\d{2}-\d{2})$")

standups: dict[str, str] = {}  # {date_str: raw_delegations_value}

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
    for o in obs:
        if isinstance(o, str) and o.startswith("delegations: "):
            delegations_value = o[len("delegations: "):]
            break
    # First occurrence of each date wins (aligns with KnowledgeGraphManager semantics)
    if date_str not in standups:
        standups[date_str] = delegations_value

# Need at least 3 standups to perform a meaningful coach check
sorted_dates = sorted(standups.keys())
if len(sorted_dates) < 3:
    sys.exit(0)

last3_dates = sorted_dates[-3:]

# ---------------------------------------------------------------------------
# 2. Parse delegation tokens
# ---------------------------------------------------------------------------
_PLACEHOLDER_RE = re.compile(r"^(none|n/a|\[\]|\[list\])$", re.IGNORECASE)


def parse_delegations(raw: str) -> list[str]:
    """Return normalised delegation tokens from the raw delegations value.

    Tokens are split on semicolons and newlines, then lowercased and stripped.
    Placeholder values (none, n/a, [], [list]) yield an empty list.

    The empty-string guard (`not raw`) short-circuits before the regex to avoid
    calling re.match on an empty string, which would not match the placeholder
    pattern anyway but is clearer to reason about.
    """
    if not raw or _PLACEHOLDER_RE.match(raw.strip()):
        return []
    tokens: list[str] = []
    for part in re.split(r"[;\n]", raw):
        part = part.strip()
        if part:
            tokens.append(part.lower())
    return tokens


delegation_sets = [set(parse_delegations(standups[d])) for d in last3_dates]

# Delegations present in ALL 3 standups
common: set[str] = delegation_sets[0] & delegation_sets[1] & delegation_sets[2]
if not common:
    sys.exit(0)

# ---------------------------------------------------------------------------
# 3. Load BOARD.md completed section
# ---------------------------------------------------------------------------
completed_text = ""
if board_file.exists():
    content = board_file.read_text(encoding="utf-8")
    m = re.search(
        r"##[^\n]*Completed[^\n]*\n(.*?)(?=\n##|\Z)",
        content,
        re.DOTALL,
    )
    if m:
        completed_text = m.group(1).lower()

# ---------------------------------------------------------------------------
# 4. Detect drift and emit report + lesson entities
# ---------------------------------------------------------------------------
today_str = date.today().isoformat()
committed_date = last3_dates[0]  # oldest of the 3 cycles

drifted: list[tuple[str, str, str]] = []  # [(agent, task_desc, delegation)]

for delegation in sorted(common):
    # Pattern: → AgentName: task description (colon required after agent name)
    task_match = re.match(r"→\s*(\S+):\s*(.+)", delegation)
    if task_match:
        agent = task_match.group(1)
        task_desc = task_match.group(2).strip()
    else:
        agent = "unknown"
        task_desc = delegation.strip()

    # Task resolved if its description appears in the BOARD.md completed section
    if task_desc and task_desc in completed_text:
        continue

    drifted.append((agent, task_desc, delegation))

if not drifted:
    sys.exit(0)

# Print drift report
for agent, task_desc, _delegation in drifted:
    print(
        f"DRIFT DETECTED — {agent} committed to {task_desc!r}"
        f" on {committed_date}, no output found"
    )

# Append lesson entity for each drifted delegation
with graph_file.open("a", encoding="utf-8") as fh:
    for agent, task_desc, _delegation in drifted:
        slug = re.sub(r"[^a-z0-9]+", "-", task_desc.lower())[:40].strip("-")
        lesson_name = f"lesson:{today_str}:drift-{agent}-{slug}"
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
        fh.write(json.dumps(lesson) + "\n")

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
