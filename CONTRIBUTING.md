# Contributing to skele-crew

> This is a solo project. This guide exists so you can resume work after any break without losing context.

## The Mental Model

This repo is a **virtual company**. You are the founder and only human employee. The agents are your departments. Your job is to:

1. Define what each department knows and is allowed to do (agent files)
2. Give them shared memory (knowledge graph)
3. Let them operate, review their proposals, and course-correct

## Daily Workflow

### Starting a Session
1. Open GitHub Copilot in the appropriate agent mode
2. The COO agent will run a daily standup automatically when you start your session
3. Review the standup output and confirm delegations
4. Work on whatever the standup prioritizes

### Working on an Issue
1. Find your issue in the [project board](https://github.com/orgs/q3ik/projects)
2. Assign it to yourself and move to "In Progress"
3. Work in a feature branch: `git checkout -b feature/issue-N-short-description`
4. Commit often with descriptive messages
5. Open a PR when done — the pre-merge hook will run automatically
6. Review, merge, close issue

### Writing to the Knowledge Graph
After any meaningful decision, lesson, or event:
```jsonl
{"type":"entity","name":"lesson:YYYY-MM-DD:short-description","entityType":"lesson","observations":["category: X","summary: what happened","action: what changed"]}
```

### Improver Proposals
1. Check `PROPOSED_CHANGES.md` monthly (or when updated by Improver agent)
2. For each proposal: APPROVE, REJECT, or DEFER with a note
3. Apply approved changes manually (do not let Improver write directly to agent files)

See [Reviewing Improver Proposals](#reviewing-improver-proposals) below for the full review process.

## File Ownership

| File/Directory | Owner | Notes |
|----------------|-------|-------|
| `.github/agents/` | Human (with Improver proposals) | Core agent definitions |
| `.github/copilot-instructions.md` | Human | Company constitution |
| `memory/knowledge-graph.jsonl` | All agents + human | Shared memory — handle with care |
| `BOARD.md` | COO Agent | Auto-updated during standup |
| `PROPOSED_CHANGES.md` | Improver Agent | Human must review before applying |
| `ops/protected-sections.manifest` | Human only | Never modified by agents |
| `docs/` | Human | Implementation specs |

## Protected Sections

Files containing `<!-- PROTECTED: ... -->` blocks are guarded by the pre-merge hook. Any PR that touches these sections is automatically rejected. To modify them:
1. Edit directly on the main branch (bypasses the PR hook)
2. Or temporarily disable the hook (document why)
3. Always create a decision entity in the knowledge graph when modifying protected sections

## Branch Strategy
- `main`: Always deployable, always reflects current state of the virtual company
- `feature/issue-N-*`: Short-lived branches for individual issues
- `proposal/*`: Improver agent proposals (never auto-merged)

## Reviewing Improver Proposals

The Improver agent generates `PROPOSED_CHANGES.md` after each monthly lesson review cycle. All proposals require human review before being applied. The Improver **never writes directly to agent or skill files**.

### Proposal Branch Naming Convention

Improver proposal branches follow the convention:

```
proposal/improver-YYYY-MM
```

Example: `proposal/improver-2026-03`

These branches are **never auto-merged**. Open a pull request using the [Improver Proposal PR template](.github/PULL_REQUEST_TEMPLATE/improver-proposal.md) so the automated proposal check runs.

### Review Checklist

For each entry in `PROPOSED_CHANGES.md`, apply one of three decisions:

| Decision | When to use | Action |
|----------|-------------|--------|
| **APPROVE** | Rationale is sound, change is safe, no protected sections touched | Apply the change manually (see below), then record in the Review Log |
| **REJECT** | Change is incorrect, unnecessary, or out of scope | Add a note explaining why; the Improver should not re-propose without new evidence |
| **DEFER** | Change may be valid but timing is wrong, or needs more data | Set a follow-up month; leave in `PROPOSED_CHANGES.md` with a DEFERRED note |

Update the **Review Log** table in `PROPOSED_CHANGES.md` after each decision.

### Applying Approved Skill Changes

Skill files live in `.github/skills/[skill-name]/SKILL.md` and do not contain protected sections by default.

1. Create a branch: `proposal/improver-YYYY-MM` (or use the existing proposal branch)
2. Edit the skill file directly with the approved content
3. Open a PR — the `proposal-check` workflow will run the pre-merge hook automatically
4. Review the workflow output; if all checks pass, merge the PR
5. Record the decision in the `PROPOSED_CHANGES.md` Review Log on `main`

### Applying Approved Agent Changes

Agent files (`.github/agents/*.agent.md`) may contain `<!-- PROTECTED: ... -->` sections. The pre-merge hook will **block any PR that modifies a protected section**.

1. Verify the proposal does **not** touch any `<!-- PROTECTED: ... -->` block
2. If it does, see [Edge Case: Protected Section Changes](#edge-case-protected-section-changes) below
3. Create a branch: `proposal/improver-YYYY-MM`
4. Apply the approved change to the agent file
5. Open a PR — the `proposal-check` workflow runs automatically
6. If the protected-sections check passes, merge the PR
7. Record the decision in the `PROPOSED_CHANGES.md` Review Log on `main`

### Edge Case: Protected Section Changes

If the Improver proposes a change that touches a `<!-- PROTECTED: ... -->` block:

1. **Do not apply via PR** — the pre-merge hook will block it regardless
2. Evaluate whether the protected section truly needs to change
3. If yes, modify the section **directly on `main`** (this bypasses the PR hook)
4. Alternatively, temporarily disable the hook, document why, re-enable immediately after
5. Always create a `decision` entity in the knowledge graph:
   ```jsonl
   {"type":"entity","name":"decision:YYYY-MM-DD:protected-section-modified","entityType":"decision","observations":["choice: modified <!-- PROTECTED: [tag] --> in [file]","rationale: [why]","agent: human","impact: [areas affected]"]}
   ```
6. The pre-merge hook's `CHECK 2` will also block any `PROPOSED_CHANGES.md` that **references a protected section tag inline** — this is by design.

## Resuming After a Break

If you haven't worked on this in a while:
1. Read `BOARD.md` — what was in progress?
2. Read the last few entries in `memory/knowledge-graph.jsonl` — what was the context?
3. Check open issues in the project board
4. Run the COO standup to get oriented
5. Pick up from where you left off

## Knowledge Graph Namespacing

Every entity in `memory/knowledge-graph.jsonl` must carry a namespace prefix that identifies its scope. This prevents agents working on different products from accidentally reading or overwriting each other's data.

### Prefix Convention

| Prefix | Scope | Example |
|--------|-------|---------|
| `product:[slug]:*` | Product-specific entities | `product:buzzy-game` |
| `decision:[YYYY-MM-DD]:[desc]` | Company-wide decisions | `decision:2026-03-16:repo-initialized` |
| `decision:[slug]:[YYYY-MM-DD]:[desc]` | Product-scoped decisions | `decision:buzzy-game:2026-04-01:pricing` |
| `deadline:[YYYY-QX]:[desc]` | Company or tax deadlines | `deadline:2026-Q2:hst-filing` |
| `lesson:[YYYY-MM-DD]:[desc]` | Company-wide lessons | `lesson:2026-03-16:start-with-three-agents` |
| `lesson:[slug]:[YYYY-MM-DD]:[desc]` | Product-scoped lessons | `lesson:buzzy-game:2026-04-01:onboarding-flow` |
| `system:[name]` | Infrastructure (not a product) | `system:skele-crew` |
| `metric:prompt:[name]:last-run` | Scheduled-prompt tracking | `metric:prompt:weekly-review:last-run` |

### Rules

1. **Product entities** use `product:[slug]` as the root name and may have sub-entities using `product:[slug]:[sub-type]` (e.g. `product:buzzy-game:feature:spelling-mode`).
2. **Product-scoped decisions/lessons** include the slug after the entity type prefix so a COO query for `product:buzzy-game:*` returns only buzzy-game data.
3. **Cross-product relations** use the `depends-on` relation type and always reference fully-qualified entity names.

### Cross-Product Relation Templates

The following lines show the format for cross-product `depends-on` relations. Uncomment and fill in the slugs when a second product is added to the registry.

```jsonl
// Template — replace product:saas-b with the real slug and remove this comment line:
// {"type":"relation","from":"product:buzzy-game","to":"product:saas-b","relationType":"depends-on"}
// {"type":"relation","from":"product:saas-b","to":"product:buzzy-game","relationType":"depends-on"}
```

---

## Troubleshooting

### Memory corruption in knowledge-graph.jsonl
The MCP memory server has auto-repair — corrupt lines are skipped on load. If you suspect corruption:
1. Check the `.tmp` file for the last clean write
2. Run the load_graph_safe function manually
3. Log a lesson entity about what caused the corruption

### Agent not consulting the right peer
Check the trigger table in the calling agent's file. If the trigger is missing, add it and log a lesson entity.

### Improver keeps proposing the same change
It means the underlying lesson keeps recurring. Either the proposed change needs to be applied, or the lesson category needs to be more specific.
