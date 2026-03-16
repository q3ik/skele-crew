#!/usr/bin/env bash
# test-standup.sh
#
# Validates the COO daily standup acceptance criteria programmatically.
# Run this after a standup has been executed to confirm all outputs are correct.
#
# Checks:
#   1. BOARD.md was modified in the last 24 hours
#   2. memory/knowledge-graph.jsonl contains a standup entity with today's date
#   3. The standup entity contains at least one delegation line (→)
#
# Usage:
#   ./scripts/test-standup.sh [--repo-root <path>]
#
# Options:
#   --repo-root <path>   Root of the repository (default: directory containing
#                        this script's parent, i.e. the repo root)
#
# Exit codes:
#   0  All checks passed
#   1  One or more checks failed

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve repo root
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/.."

while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo-root)
            REPO_ROOT="$2"
            shift 2
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"
BOARD_FILE="$REPO_ROOT/BOARD.md"
GRAPH_FILE="$REPO_ROOT/memory/knowledge-graph.jsonl"

TODAY="$(date +%Y-%m-%d)"
PASS=0
FAIL=0

pass() { echo "  ✅ PASS: $*"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ FAIL: $*" >&2; FAIL=$((FAIL + 1)); }

echo "=== COO Standup Acceptance Tests ==="
echo "Repo root : $REPO_ROOT"
echo "Date      : $TODAY"
echo ""

# ---------------------------------------------------------------------------
# Check 1: BOARD.md modified in the last 24 hours
# ---------------------------------------------------------------------------
echo "[ 1 ] BOARD.md updated in the last 24 hours"

if [[ ! -f "$BOARD_FILE" ]]; then
    fail "BOARD.md not found at $BOARD_FILE"
else
    # Use find with -mtime -1 (less than 1 day ago) to stay portable across
    # Linux and macOS without requiring GNU-specific stat flags.
    if find "$BOARD_FILE" -mtime -1 | grep -q .; then
        pass "BOARD.md was modified within the last 24 hours"
    else
        fail "BOARD.md has NOT been modified in the last 24 hours (standup may not have run)"
    fi
fi

# ---------------------------------------------------------------------------
# Check 2: knowledge-graph.jsonl contains a standup entity for today
# ---------------------------------------------------------------------------
echo ""
echo "[ 2 ] knowledge-graph.jsonl contains a standup entity for $TODAY"

if [[ ! -f "$GRAPH_FILE" ]]; then
    fail "knowledge-graph.jsonl not found at $GRAPH_FILE"
else
    STANDUP_LINE="$(grep -E "\"name\":\"standup:${TODAY}\"" "$GRAPH_FILE" || true)"
    if [[ -n "$STANDUP_LINE" ]]; then
        pass "Found standup entity for $TODAY in knowledge-graph.jsonl"
    else
        fail "No standup entity for $TODAY found in knowledge-graph.jsonl"
        echo "       Expected a line matching: {\"name\":\"standup:${TODAY}\", ...}" >&2
    fi
fi

# ---------------------------------------------------------------------------
# Check 3: Standup entity contains at least one delegation (→)
# ---------------------------------------------------------------------------
echo ""
echo "[ 3 ] Standup entity for $TODAY contains at least one delegation (→)"

if [[ ! -f "$GRAPH_FILE" ]]; then
    fail "knowledge-graph.jsonl not found — skipping delegation check"
else
    STANDUP_LINE="$(grep -E "\"name\":\"standup:${TODAY}\"" "$GRAPH_FILE" || true)"
    if [[ -z "$STANDUP_LINE" ]]; then
        fail "No standup entity for $TODAY — cannot check delegations"
    else
        # The delegation arrow may appear as → (Unicode) or -> in observations
        if echo "$STANDUP_LINE" | grep -qE '→|->'; then
            pass "Standup entity contains at least one delegation (→)"
        else
            fail "No delegation line (→) found in the standup entity for $TODAY"
            echo "       Ensure the standup delegations field lists at least one '→ Agent: task'" >&2
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ $FAIL -gt 0 ]]; then
    echo ""
    echo "One or more checks failed. Run the COO standup (open GitHub Copilot in"
    echo "COO agent mode and prompt: \"Run daily standup\"), then re-run this script."
    exit 1
fi

echo ""
echo "All acceptance criteria met — Phase 1 standup validated successfully."
exit 0
