## Improver Proposal Review

> This template is for `proposal/improver-*` branches only.
> Complete every checkbox before requesting a merge.

### Proposal branch
<!-- Branch name must follow the convention: proposal/improver-YYYY-MM -->

### Summary of changes
<!-- One sentence per changed file. Example: "Updated .github/skills/ontario-canada-tax/SKILL.md — added HST filing frequency note." -->

---

### Pre-merge checklist

#### Protected sections
- [ ] No `<!-- PROTECTED: ... -->` blocks were modified in any file
- [ ] `PROPOSED_CHANGES.md` does not reference any protected section tag inline
- [ ] The **Protected sections affected** field in `PROPOSED_CHANGES.md` is set to `none` (or lists tag names only, never content)

#### Rationale review
- [ ] Each proposal entry in `PROPOSED_CHANGES.md` cites at least one lesson entity from the knowledge graph
- [ ] The **Rationale** section explains a recurring pattern, not a one-off event
- [ ] The proposed change has been marked **APPROVED** in the `PROPOSED_CHANGES.md` Review Log

#### Isolation testing
- [ ] Skill file changes have been verified for technical accuracy against an authoritative source
- [ ] Agent file changes do not alter the agent's core responsibilities or consultation rules in an unintended way
- [ ] The `proposal-check` workflow passed on this PR (see Actions tab)

---

### Review Log update
After merging, update the `PROPOSED_CHANGES.md` Review Log on `main` with the final decision and date.
