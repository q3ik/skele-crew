#!/bin/bash
# Runner-side pre-merge protection check
#
# Three independent checks:
#
#   CHECK 1 — Direct file diff (the real guardrail)
#   Parse ops/protected-sections.manifest FROM THE BASE BRANCH (not the PR's
#   working-tree copy), extract the files: list under each protected_block, and
#   fail if any of those files were modified in this PR.
#   Reading from the base branch prevents an attacker from weakening the policy
#   by removing entries from the manifest in the same PR.
#
#   CHECK 2 — PROPOSED_CHANGES.md tag check (secondary guardrail)
#   If PROPOSED_CHANGES.md exists, ensure it does not reference any protected
#   section tag (read from the base manifest). Proposals must never embed
#   protected content inline.
#
#   CHECK 3 — Manifest weakening detection
#   Compare the base-branch manifest's protected-file list with the PR's
#   manifest. Fail if any entry present in the base manifest has been removed,
#   so policy can only be strengthened, never silently weakened.
#
# CRITICAL: This runs on the CI runner, NOT inside an agent.
# Agents cannot validate their own output against this manifest.
#
# Environment variables used (set by GitHub Actions automatically):
#   GITHUB_BASE_REF  — target branch of the PR (e.g. "main")
#   GITHUB_HEAD_REF  — source branch of the PR
#
# When run locally (outside CI), pass the base branch as $1 (default: main).

set -euo pipefail

MANIFEST="ops/protected-sections.manifest"
PROPOSED="PROPOSED_CHANGES.md"
BASE_REF="${GITHUB_BASE_REF:-${1:-main}}"

# ---------------------------------------------------------------------------
# Sanity checks
# ---------------------------------------------------------------------------
if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: protected-sections.manifest not found at $MANIFEST"
  exit 1
fi

# Require yq or python to parse YAML manifest; fall back to grep-based parsing
# Since yq may not be available on all runners, we use Python (always present).
if ! command -v python3 &>/dev/null; then
  echo "ERROR: python3 is required to parse the YAML manifest"
  exit 1
fi

# ---------------------------------------------------------------------------
# Determine the list of files changed in this PR vs the base branch
# ---------------------------------------------------------------------------
# Fetch the base branch tip so git diff works even with a shallow clone.
git fetch origin "$BASE_REF" --depth=1 2>/dev/null || true
CHANGED_FILES=$(git diff --name-only "origin/${BASE_REF}...HEAD" 2>/dev/null || \
                git diff --name-only "origin/${BASE_REF}" HEAD)

# ---------------------------------------------------------------------------
# Read the manifest from the BASE branch.
# Using the base-branch copy prevents a PR from weakening policy by removing
# entries from the manifest in the same commit set.
# ---------------------------------------------------------------------------
BASE_MANIFEST=$(git show "origin/${BASE_REF}:${MANIFEST}" 2>/dev/null) || {
  echo "ERROR: Cannot read ${MANIFEST} from origin/${BASE_REF}."
  echo "       The manifest must exist on the base branch before policy can be enforced."
  exit 1
}
# Export so the Python heredocs below can access it without a temp file.
export _BASE_MANIFEST="$BASE_MANIFEST"

echo "Base ref:       origin/${BASE_REF}"
echo "Changed files:"
echo "$CHANGED_FILES" | sed 's/^/  /'
echo ""

# ---------------------------------------------------------------------------
# CHECK 1 — Protected file diff
#
# Extract every file path listed under any protected_block's files: array,
# read from the BASE BRANCH manifest to prevent policy weakening via PR edits.
# Uses Python to parse the YAML without requiring yq.
# ---------------------------------------------------------------------------
PROTECTED_FILES=$(python3 - <<'PYEOF'
import sys, re, os

content = os.environ['_BASE_MANIFEST']

# Match file entries: lines of the form "      - ".github/agents/foo.agent.md"
# Skip commented-out lines (lines where the first non-space char is #)
files = []
in_files_block = False
for line in content.splitlines():
    stripped = line.strip()
    # Detect start of a files: block
    if re.match(r'^files:', stripped):
        in_files_block = True
        continue
    # Any key (non-indented or less-indented key:) ends the files block
    if in_files_block and re.match(r'^\S', stripped) and not stripped.startswith('-'):
        in_files_block = False
    if in_files_block:
        # Skip commented lines
        if stripped.startswith('#'):
            continue
        # Match list entries: "- path"
        m = re.match(r'^-\s+"?([^"#\s]+)"?', stripped)
        if m:
            files.append(m.group(1))

for f in files:
    print(f)
PYEOF
)

echo "Protected files (from manifest):"
echo "$PROTECTED_FILES" | sed 's/^/  /'
echo ""

VIOLATIONS=0

while IFS= read -r protected_file; do
  [ -z "$protected_file" ] && continue
  if echo "$CHANGED_FILES" | grep -qF "$protected_file"; then
    echo "❌ BLOCKED: Protected file modified directly: $protected_file"
    echo "   Changes to this file require human approval and an audit trail."
    echo "   Use PROPOSED_CHANGES.md to propose edits; do not commit directly."
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done <<< "$PROTECTED_FILES"

# ---------------------------------------------------------------------------
# CHECK 3 — Manifest weakening detection
#
# Parse the PR's working-tree manifest and compare its protected-file list
# against the base manifest (already parsed into $PROTECTED_FILES above).
# Fail if any entry present in the base manifest is absent from the PR's
# manifest — this prevents silently narrowing the protection policy.
# ---------------------------------------------------------------------------
echo "Checking for removed manifest entries (policy-weakening detection)..."

PR_PROTECTED_FILES=$(python3 - <<'PYEOF'
import sys, re

with open("ops/protected-sections.manifest") as f:
    content = f.read()

files = []
in_files_block = False
for line in content.splitlines():
    stripped = line.strip()
    if re.match(r'^files:', stripped):
        in_files_block = True
        continue
    if in_files_block and re.match(r'^\S', stripped) and not stripped.startswith('-'):
        in_files_block = False
    if in_files_block:
        if stripped.startswith('#'):
            continue
        m = re.match(r'^-\s+"?([^"#\s]+)"?', stripped)
        if m:
            files.append(m.group(1))

for f in files:
    print(f)
PYEOF
)

while IFS= read -r base_file; do
  [ -z "$base_file" ] && continue
  if ! echo "$PR_PROTECTED_FILES" | grep -qF "$base_file"; then
    echo "❌ BLOCKED: Protected entry removed from manifest: $base_file"
    echo "   Removing files from the manifest weakens policy and requires human approval."
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done <<< "$PROTECTED_FILES"

# ---------------------------------------------------------------------------
# CHECK 2 — PROPOSED_CHANGES.md tag check (secondary guardrail)
# ---------------------------------------------------------------------------
if [ -f "$PROPOSED" ]; then
  PROTECTED_TAGS=$(python3 - <<'PYEOF'
import re, os
content = os.environ['_BASE_MANIFEST']
for line in content.splitlines():
    stripped = line.strip()
    if stripped.startswith('#'):
        continue
    m = re.match(r'^tag:\s+"?([^"]+)"?', stripped)
    if m:
        print(m.group(1))
PYEOF
  )

  while IFS= read -r tag; do
    [ -z "$tag" ] && continue
    if grep -qF "$tag" "$PROPOSED"; then
      echo "❌ BLOCKED: PROPOSED_CHANGES.md references protected section tag: $tag"
      echo "   Proposals must not embed protected content inline."
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  done <<< "$PROTECTED_TAGS"
else
  echo "INFO: No PROPOSED_CHANGES.md found — skipping tag check"
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
echo ""
if [ $VIOLATIONS -gt 0 ]; then
  echo "Pre-merge check FAILED: $VIOLATIONS violation(s) found."
  echo "Human review is required before these changes can be merged."
  exit 1
fi

echo "✅ PASS: No protected sections modified"
exit 0
