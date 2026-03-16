#!/usr/bin/env bash
# validate-peer-review-format.sh
#
# Validates that a peer review request file contains all required fields
# defined in TEMPLATES.md.
#
# Usage:
#   ./scripts/validate-peer-review-format.sh <file>
#
# Exits with 0 if all required fields are present; non-zero otherwise.

set -euo pipefail

FILE="${1:-}"

if [[ -z "$FILE" ]]; then
    echo "Usage: $0 <peer-review-request-file>" >&2
    exit 1
fi

if [[ ! -f "$FILE" ]]; then
    echo "Error: file not found: $FILE" >&2
    exit 1
fi

REQUIRED_FIELDS=(
    "**From**:"
    "**Call chain**:"
    "**Depth**:"
    "**Task**:"
    "**What I did**:"
    "**What I need"
)

MISSING=0

for field in "${REQUIRED_FIELDS[@]}"; do
    if ! grep -qF "$field" "$FILE"; then
        echo "MISSING required field: $field" >&2
        MISSING=$((MISSING + 1))
    fi
done

if [[ $MISSING -gt 0 ]]; then
    echo "Validation FAILED: $MISSING required field(s) missing in $FILE" >&2
    exit 1
fi

echo "Validation PASSED: all required fields present in $FILE"
exit 0
