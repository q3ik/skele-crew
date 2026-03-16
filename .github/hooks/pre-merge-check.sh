#!/bin/bash
# Runner-side pre-merge protection check
# Validates that PROPOSED_CHANGES.md does not touch protected sections
# CRITICAL: This runs on the CI runner, NOT inside an agent. Agents cannot validate their own output.

MANIFEST="ops/protected-sections.manifest"
PROPOSED="PROPOSED_CHANGES.md"

if [ ! -f "$PROPOSED" ]; then
  echo "INFO: No PROPOSED_CHANGES.md found — skipping check"
  exit 0
fi

if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: protected-sections.manifest not found at $MANIFEST"
  exit 1
fi

VIOLATIONS=0

# Extract protected tags from manifest and check proposed changes
for tag in $(grep -oP '(?<=tag: ").*(?=")' $MANIFEST); do
  if grep -q "$tag" "$PROPOSED"; then
    echo "❌ BLOCKED: Proposed change touches protected section: $tag"
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done

if [ $VIOLATIONS -gt 0 ]; then
  echo ""
  echo "Pre-merge check FAILED: $VIOLATIONS protected section violation(s) found."
  echo "Human review required before these changes can be merged."
  exit 1
fi

echo "✅ PASS: No protected sections modified"
exit 0
