#!/usr/bin/env bash
# test-standup.sh
#
# Validates the COO daily standup acceptance criteria programmatically.
# Run this after a standup has been executed to confirm all outputs are correct.
#
# Checks:
#   1. BOARD.md was modified in the last 24 hours
#   2. BOARD.md content: "Last updated:" shows today and required sections exist
#   3. knowledge-graph.jsonl contains a standup entity for today with all
#      required observation fields (errors, overdue-tasks, delegations, priority-1)
#   4. Standup entity has a populated (non-placeholder) Sentry errors field
#   5. Standup entity has at least one non-empty delegation
#   6. Periodic prompt metric entities exist; overdue prompts are reported
#
# Usage:
#   ./scripts/test-standup.sh [--repo-root <path>]
#
# Options:
#   --repo-root <path>   Root of the repository (default: directory containing
#                        this script's parent, i.e. the repo root)
#
# Exit codes:
#   0  All checks passed (warnings for overdue prompts are informational)
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
            if [[ -z "${2:-}" ]]; then
                echo "Error: --repo-root requires a path argument" >&2
                exit 1
            fi
            if [[ ! -d "$2" ]]; then
                echo "Error: --repo-root path not found: $2" >&2
                exit 1
            fi
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
WARN=0

# Delegation observation values that are considered empty / placeholder
DELEGATION_PLACEHOLDER_RE='^(none|n/a|\[\]|\[list\])$'

pass() { echo "  ✅ PASS: $*"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ FAIL: $*" >&2; FAIL=$((FAIL + 1)); }
warn() { echo "  ⚠️  WARN: $*"; WARN=$((WARN + 1)); }

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
# Check 2: BOARD.md content — "Last updated:" shows today's date and all
#          required sections are present
# ---------------------------------------------------------------------------
echo ""
echo "[ 2 ] BOARD.md content verification"

if [[ -f "$BOARD_FILE" ]]; then
    if grep -qF "Last updated: ${TODAY}" "$BOARD_FILE"; then
        pass "BOARD.md 'Last updated:' shows today ($TODAY)"
    else
        fail "BOARD.md 'Last updated:' does not show today's date ($TODAY)"
    fi

    for section in "🔴 Overdue" "🟡 In Progress" "🔄 Periodic Prompts"; do
        if grep -qF "$section" "$BOARD_FILE"; then
            pass "BOARD.md contains required section: $section"
        else
            fail "BOARD.md missing required section: $section"
        fi
    done
fi

# ---------------------------------------------------------------------------
# Check 3: knowledge-graph.jsonl contains a standup entity for today with all
#          required observation fields
# ---------------------------------------------------------------------------
echo ""
echo "[ 3 ] Standup entity present with all required fields"

STANDUP_LINE=""
if [[ ! -f "$GRAPH_FILE" ]]; then
    fail "knowledge-graph.jsonl not found at $GRAPH_FILE"
else
    STANDUP_LINE="$(grep -E "\"name\":\"standup:${TODAY}\"" "$GRAPH_FILE" || true)"
    if [[ -n "$STANDUP_LINE" ]]; then
        pass "Found standup entity for $TODAY in knowledge-graph.jsonl"

        for field in "errors:" "overdue-tasks:" "delegations:" "priority-1:"; do
            if echo "$STANDUP_LINE" | grep -qF "\"${field}"; then
                pass "Standup entity has required field: $field"
            else
                fail "Standup entity missing required field: $field"
            fi
        done
    else
        fail "No standup entity for $TODAY found in knowledge-graph.jsonl"
        echo "       Expected a line matching: {\"name\":\"standup:${TODAY}\", ...}" >&2
    fi
fi

# ---------------------------------------------------------------------------
# Check 4: Sentry errors field is populated (not a placeholder)
# ---------------------------------------------------------------------------
echo ""
echo "[ 4 ] Sentry errors field populated"

if [[ -z "$STANDUP_LINE" ]]; then
    fail "Cannot check Sentry field — no standup entity found"
else
    ERRORS_VALUE="$(echo "$STANDUP_LINE" | grep -oE '"errors: [^"]*"' | head -1 || true)"
    if [[ -z "$ERRORS_VALUE" ]]; then
        fail "Sentry errors observation not found in standup entity"
    elif echo "$ERRORS_VALUE" | grep -qF '"errors: [count]"'; then
        fail "Sentry errors field still contains placeholder '[count]' — run standup with live Sentry data"
    else
        pass "Sentry errors field is populated: $ERRORS_VALUE"
    fi
fi

# ---------------------------------------------------------------------------
# Check 5: Standup entity has at least one non-empty, non-placeholder delegation
# ---------------------------------------------------------------------------
echo ""
echo "[ 5 ] At least one delegation present"

if [[ -z "$STANDUP_LINE" ]]; then
    fail "Cannot check delegations — no standup entity found"
else
    DELEGATIONS_VALUE="$(echo "$STANDUP_LINE" | grep -oE '"delegations: [^"]*"' | head -1 || true)"
    if [[ -z "$DELEGATIONS_VALUE" ]]; then
        fail "No 'delegations:' observation found in standup entity"
    else
        # Strip the JSON key prefix and surrounding quotes to get the bare value
        DELEGATIONS_CONTENT="${DELEGATIONS_VALUE#\"delegations: }"
        DELEGATIONS_CONTENT="${DELEGATIONS_CONTENT%\"}"
        if [[ -z "$DELEGATIONS_CONTENT" ]] || \
           echo "$DELEGATIONS_CONTENT" | grep -qiE "$DELEGATION_PLACEHOLDER_RE"; then
            fail "Delegations field is empty or placeholder: $DELEGATIONS_VALUE"
            echo "       At least one delegation to Marketing or Accountant is required" >&2
        else
            pass "Standup entity has delegations: $DELEGATIONS_VALUE"
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Check 6: Periodic prompt metric entities exist; overdue prompts are reported
#          as warnings (overdue status is informational, not a failure)
# ---------------------------------------------------------------------------
echo ""
echo "[ 6 ] Periodic prompt checks"

if [[ ! -f "$GRAPH_FILE" ]]; then
    fail "knowledge-graph.jsonl not found — skipping periodic prompt checks"
else
    PROMPTS_FOUND=0
    PROMPTS_OVERDUE=0

    while IFS= read -r line; do
        if ! echo "$line" | grep -qE '"name":"metric:prompt:[^"]+:last-run"'; then
            continue
        fi

        PROMPTS_FOUND=$((PROMPTS_FOUND + 1))
        PROMPT_NAME="$(echo "$line" | grep -oE '"name":"metric:prompt:[^"]*"' | grep -oE 'metric:prompt:[^"]*' || true)"
        CADENCE="$(echo "$line" | grep -oE '"cadence_days: [0-9]+"' | grep -oE '[0-9]+' || true)"
        LAST_RUN="$(echo "$line" | grep -oE '"last_run: [0-9]{4}-[0-9]{2}-[0-9]{2}"' | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' || true)"

        if [[ -z "$CADENCE" || -z "$LAST_RUN" ]]; then
            warn "Prompt $PROMPT_NAME: missing cadence_days or last_run — cannot determine overdue status"
            continue
        fi

        # Calculate days since last run (python3 used for portable date arithmetic)
        if ! command -v python3 >/dev/null 2>&1; then
            warn "Prompt $PROMPT_NAME: python3 not found — cannot determine overdue status (install python3 to enable this check)"
            continue
        fi
        DAYS_SINCE="$(python3 - "$LAST_RUN" "$TODAY" <<'PYEOF' 2>/dev/null || true
import sys
from datetime import date
last = date.fromisoformat(sys.argv[1])
today = date.fromisoformat(sys.argv[2])
print((today - last).days)
PYEOF
)"

        if [[ -z "$DAYS_SINCE" ]]; then
            warn "Prompt $PROMPT_NAME: could not calculate days since last run (invalid date format in last_run: '$LAST_RUN')"
            continue
        fi

        if [[ "$DAYS_SINCE" -gt "$CADENCE" ]]; then
            PROMPTS_OVERDUE=$((PROMPTS_OVERDUE + 1))
            warn "Prompt $PROMPT_NAME is OVERDUE by $((DAYS_SINCE - CADENCE)) day(s) (cadence: ${CADENCE}d, last run: $LAST_RUN)"
        else
            pass "Prompt $PROMPT_NAME: up to date (last run: $LAST_RUN, cadence: ${CADENCE}d, days since: $DAYS_SINCE)"
        fi
    done < "$GRAPH_FILE"

    if [[ "$PROMPTS_FOUND" -eq 0 ]]; then
        fail "No periodic prompt metric entities found in knowledge-graph.jsonl"
        echo "       Expected entities matching: metric:prompt:*:last-run" >&2
    else
        ENTITY_WORD="entities"
        if [[ "$PROMPTS_FOUND" -eq 1 ]]; then ENTITY_WORD="entity"; fi
        pass "Found $PROMPTS_FOUND periodic prompt metric $ENTITY_WORD ($PROMPTS_OVERDUE overdue — shown as warnings above)"
    fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Results: $PASS passed, $FAIL failed, $WARN warnings ==="

if [[ $FAIL -gt 0 ]]; then
    echo ""
    echo "One or more checks failed. Run the COO standup (open GitHub Copilot in"
    echo "COO agent mode and prompt: \"Run daily standup\"), then re-run this script."
    exit 1
fi

echo ""
echo "All programmatic checks passed — standup output structure is valid."
echo "Note: overdue periodic prompts (shown as warnings above) are informational only."
exit 0
