# Phase 3: Advanced Features (Weeks 5–6)

> Milestone due: April 27, 2026

## Objective
Automate the COO daily standup, build the Improver agent, implement drift detection, and establish the PROPOSED_CHANGES.md review workflow. By end of Week 6, the system should self-report problems and propose improvements without prompting.

## Daily Standup Automation

### Full Standup Sequence
The COO agent runs this automatically at session start:

1. Query MCP memory for current context (`memory/knowledge-graph.jsonl`)
2. Check Sentry MCP for errors across all products (filter by severity)
3. Scan BOARD.md for overdue items (tasks past due date with no completion mark)
4. Check periodic prompts: weekly review, monthly accounting, quarterly tax
5. Delegate tasks with explicit assignments (write to BOARD.md)
6. Output prioritized day plan (see template in TEMPLATES.md)
7. Write standup entity to knowledge graph (retention: 7 days)

### Coach Check (Every 3 Standups)
Run after the main standup sequence every third cycle:

```markdown
## COO: Coach Check
- Compare BOARD.md tasks from 3 cycles ago vs today
- Flag any task in all 3 standups without progress
- Check if agents stated an action but no corresponding output exists
- Report: "DRIFT DETECTED — [agent] committed to [action] on [date], no output found"
```

Drift triggers: escalate to human + write a `lesson` entity about the blocked task.

## Improver Agent

### Monthly Cycle
1. Query all `lesson` entities from past 30 days
2. Group by category: `bug`, `hallucination`, `missed-deadline`, `wrong-domain`, `scope-creep`
3. For 3+ lessons in same category: create or update a `SKILL.md`
4. For gaps in agent coverage (domain appears 5+ times with no owner): draft new `.agent.md`
5. Output all proposals as `PROPOSED_CHANGES.md`

### Pattern Detection Logic
```
If count(lessons where category == X) >= 3:
    Create/update skills/[category-X]/SKILL.md
    
If count(lessons where domain == Y AND no_agent_owns == true) >= 5:
    Draft .github/agents/[Y].agent.md (proposal only)
```

### Hard Limits on Improver
- Can create/update `skills/*/SKILL.md` files (additive)
- Can write lesson entities to memory
- CANNOT modify existing `.agent.md` files — proposal only
- CANNOT touch any `<!-- PROTECTED: ... -->` section
- All proposals go to `PROPOSED_CHANGES.md` for human review

### PROPOSED_CHANGES.md Format
See template in TEMPLATES.md.

## Protected Section Tags
Add these to agent files before Milestone 3 completes:
- `<!-- PROTECTED: financial-thresholds -->` in accountant.agent.md, cfo.agent.md
- `<!-- PROTECTED: legal-compliance -->` in lawyer.agent.md, accountant.agent.md, jurisdiction-tax/SKILL.md
- `<!-- PROTECTED: auth-logic -->` in cto.agent.md

## Weeks 5–6 Checklist

### Week 5
- [ ] Build COO daily standup automation (full sequence)
- [ ] Create and configure BOARD.md with COO maintenance routines
- [ ] Implement COO coach drift detection (every 3 standups)
- [ ] Add scheduling MCP for periodic prompt tracking

### Week 6
- [ ] Write `Improver.agent.md`
- [ ] Implement lesson entity parsing and pattern detection
- [ ] Build skill creation flow in Improver
- [ ] Create PROPOSED_CHANGES.md review workflow
- [ ] Hard-code `<!-- PROTECTED: ... -->` tags in all relevant agent files
- [ ] Run first monthly Improver cycle on accumulated lessons

## Risk Mitigation

| Risk | Prevention | Recovery |
|------|-----------|---------|
| Improver modifying protected sections | Hard-coded tags + runner-side check (Phase 4) | Pre-merge hook catches violations |
| Standup context window overflow | Agents delegate data-gathering; bound summaries | Break tasks into bounded subtasks |
| Coach check reporting false drift | Only flag tasks present in ALL 3 standups | Tune threshold based on task granularity |
| Improver creating redundant skills | Deduplicate by category before creating new SKILL.md | Review PROPOSED_CHANGES.md before merging |

## Success Criteria for Milestone 3

- [ ] COO standup runs end-to-end and produces a valid BOARD.md update
- [ ] Coach check fires after 3 standup cycles and identifies at least one drift pattern (even if fabricated for testing)
- [ ] Improver reads lesson entities and produces at least one PROPOSED_CHANGES.md entry
- [ ] Protected section tags are present in all relevant agent files
- [ ] PROPOSED_CHANGES.md review workflow is documented and tested
