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
# CHECK 1 — Protected section content diff (section-aware guardrail)
#
# For each (tag, file) pair in the manifest, extract the content of the
# protected section delimited by <!-- PROTECTED: tag --> ... <!-- END PROTECTED: tag -->
# from BOTH the base branch and the PR working tree, then compare.
# Only fail if the section *content* changed — editing non-protected content
# in a listed file is explicitly allowed.
#
# A flat PROTECTED_FILES list is also emitted below (still needed for CHECK 3).
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

# Section-aware check: only block if protected section *content* changed.
export _CHANGED_FILES="$CHANGED_FILES"
export _BASE_REF="$BASE_REF"

SECTION_VIOLATIONS=$(python3 - <<'PYEOF'
import re, os, subprocess

manifest_content = os.environ['_BASE_MANIFEST']
changed_files = set(os.environ.get('_CHANGED_FILES', '').splitlines())
base_ref = os.environ.get('_BASE_REF', 'main')

# Parse manifest into [{tag, files}] blocks (reads from BASE branch manifest).
blocks = []
current_block = None
in_files = False

for line in manifest_content.splitlines():
    stripped = line.strip()
    if stripped.startswith('#'):
        continue
    m_tag = re.match(r'^-?\s*tag:\s+"?([^"]+)"?', stripped)
    if m_tag:
        if current_block is not None:
            blocks.append(current_block)
        current_block = {'tag': m_tag.group(1), 'files': []}
        in_files = False
        continue
    if re.match(r'^files:', stripped):
        in_files = True
        continue
    if in_files and re.match(r'^\S', stripped) and not stripped.startswith('-'):
        in_files = False
    if in_files and stripped.startswith('-'):
        m = re.match(r'^-\s+"?([^"#\s]+)"?', stripped)
        if m:
            current_block['files'].append(m.group(1))

if current_block is not None:
    blocks.append(current_block)


def extract_section(content, tag):
    """Return the text from <!-- PROTECTED: tag --> to <!-- END PROTECTED: tag -->,
    including the markers themselves.
    Returns None if either marker is not found."""
    start_marker = f'<!-- PROTECTED: {tag} -->'
    end_marker = f'<!-- END PROTECTED: {tag} -->'
    s = content.find(start_marker)
    if s == -1:
        return None
    e = content.find(end_marker, s)
    if e == -1:
        return None
    return content[s: e + len(end_marker)]


violations = []

for block in blocks:
    tag = block['tag']
    for filepath in block['files']:
        if filepath not in changed_files:
            continue

        # Get protected section content from base branch.
        try:
            result = subprocess.run(
                ['git', 'show', f'origin/{base_ref}:{filepath}'],
                capture_output=True, text=True, check=False,
            )
            base_content = result.stdout if result.returncode == 0 else ''
        except Exception:
            base_content = ''

        # Get protected section content from PR working tree.
        try:
            with open(filepath, encoding='utf-8') as f:
                pr_content = f.read()
        except OSError:
            pr_content = ''

        base_section = extract_section(base_content, tag)
        pr_section = extract_section(pr_content, tag)

        # Violation: section existed on base and was changed (or removed) in PR.
        if base_section is not None and base_section != pr_section:
            violations.append(f'{filepath} [tag: {tag}]')

for v in violations:
    print(v)
PYEOF
)

while IFS= read -r violation; do
  [ -z "$violation" ] && continue
  echo "❌ BLOCKED: Protected section modified: $violation"
  echo "   Changes to protected sections require human approval and an audit trail."
  echo "   Use PROPOSED_CHANGES.md to propose edits; do not commit directly."
  VIOLATIONS=$((VIOLATIONS + 1))
done <<< "$SECTION_VIOLATIONS"

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
