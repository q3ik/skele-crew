# Implementation Timeline

> 8-week plan starting March 16, 2026.
> Track progress on the [GitHub Project board](https://github.com/orgs/q3ik/projects).

## Overview

| Phase | Weeks | Milestone | Due Date |
|-------|-------|-----------|----------|
| Foundation | 1–2 | Milestone 1 | March 30, 2026 |
| Communication & Memory | 3–4 | Milestone 2 | April 13, 2026 |
| Advanced Features | 5–6 | Milestone 3 | April 27, 2026 |
| Hardening & Production | 7–8 | Milestone 4 | May 11, 2026 |
| Post-Launch | Ongoing | Milestone 5 | June 8, 2026 |

---

## Week 1 (March 16–22) — Infrastructure Foundation

**Goal:** The repo exists, memory works, and the first agent can read/write to it.

| Issue | Task | Labels |
|-------|------|--------|
| #1 | Project Initialization (repo + board + milestones) | `phase:foundation` `type:setup` `priority:high` |
| #2 | Set up repo directory structure | `phase:foundation` `type:setup` `priority:high` |
| #3 | Fork and harden MCP memory server | `phase:foundation` `type:setup` `priority:high` `agent:infrastructure` |
| #4 | Initialize knowledge-graph.jsonl with product entities | `phase:foundation` `type:setup` `priority:high` |
| #5 | Set up Sentry MCP integration | `phase:foundation` `type:setup` `priority:medium` `agent:infrastructure` |
| #6 | Write copilot-instructions.md (company constitution) | `phase:foundation` `type:documentation` `priority:high` |

---

## Week 2 (March 23–29) — First 3 Agent Files

**Goal:** COO can run a standup and delegate. Marketing and Accountant files are complete.

| Issue | Task | Labels |
|-------|------|--------|
| #7 | Create COO agent file | `phase:foundation` `type:feature` `priority:high` `agent:coo` |
| #8 | Create Marketing agent file | `phase:foundation` `type:feature` `priority:high` `agent:marketing` |
| #9 | Create Accountant agent file + tax SKILL.md | `phase:foundation` `type:feature` `priority:high` `agent:accountant` |
| #10 | Set up MCP scheduler server | `phase:foundation` `type:setup` `priority:medium` `agent:infrastructure` |
| #11 | Set up social media MCP (X + dev.to) | `phase:foundation` `type:setup` `priority:medium` `agent:marketing` |
| #12 | Run first manual COO standup and verify BOARD.md | `phase:foundation` `type:testing` `priority:high` `agent:coo` |
| #13 | Test Marketing→Lawyer peer review format | `phase:foundation` `type:testing` `priority:medium` `agent:marketing` |

---

## Week 3 (March 30 – April 5) — Inter-Agent Protocol

**Goal:** Call-chain tracking works. No infinite loops. Consultation heuristic in place.

| Issue | Task | Labels |
|-------|------|--------|
| #14 | Design and implement call-chain tracking protocol | `phase:communication` `type:feature` `priority:high` |
| #15 | Implement peer review request/response format in all agents | `phase:communication` `type:feature` `priority:high` |
| #16 | Add consultation heuristic fallback to all agent files | `phase:communication` `type:feature` `priority:medium` |
| #17 | Define and encode trigger table in each agent file | `phase:communication` `type:feature` `priority:high` |

---

## Week 4 (April 6–12) — Knowledge Graph Implementation

**Goal:** Memory server is hardened. Citation tracking works. Multi-product namespace in place.

| Issue | Task | Labels |
|-------|------|--------|
| #18 | Implement write contention solution (mutex + atomic writes + auto-repair) | `phase:communication` `type:feature` `priority:high` `agent:infrastructure` |
| #19 | Implement citation tracking wrapper on memory reads | `phase:communication` `type:feature` `priority:medium` `agent:infrastructure` |
| #20 | Test write contention with parallel agent calls | `phase:communication` `type:testing` `priority:high` |
| #21 | Add multi-product namespace to knowledge graph | `phase:communication` `type:feature` `priority:medium` |
| #22 | Write unit tests for memory server | `phase:communication` `type:testing` `priority:medium` |
| #23 | Implement memory pruning (standups >7 days) | `phase:communication` `type:feature` `priority:medium` `agent:infrastructure` |

---

## Week 5 (April 13–19) — Daily Standup Automation

**Goal:** COO standup runs end-to-end automatically with delegation.

| Issue | Task | Labels |
|-------|------|--------|
| #24 | Build COO daily standup automation | `phase:advanced` `type:feature` `priority:high` `agent:coo` |
| #25 | Create and configure BOARD.md with COO maintenance routines | `phase:advanced` `type:feature` `priority:high` `agent:coo` |
| #26 | Implement COO coach drift detection (every 3 standups) | `phase:advanced` `type:feature` `priority:medium` `agent:coo` |
| #27 | Add scheduling MCP for periodic prompt tracking | `phase:advanced` `type:setup` `priority:medium` `agent:infrastructure` |

---

## Week 6 (April 20–26) — Improver Agent

**Goal:** Improver completes first monthly cycle and produces PROPOSED_CHANGES.md.

| Issue | Task | Labels |
|-------|------|--------|
| #28 | Create Improver agent file | `phase:advanced` `type:feature` `priority:high` `agent:improver` |
| #29 | Implement lesson entity parsing and pattern detection | `phase:advanced` `type:feature` `priority:high` `agent:improver` |
| #30 | Implement skill creation automation in Improver | `phase:advanced` `type:feature` `priority:medium` `agent:improver` |
| #31 | Create PROPOSED_CHANGES.md review workflow | `phase:advanced` `type:feature` `priority:high` `agent:improver` |
| #32 | Hard-code protected section tags in all agent files | `phase:advanced` `type:security` `priority:high` |

---

## Week 7 (April 27 – May 3) — Hardening

**Goal:** Protected sections manifest + pre-merge hook working end-to-end.

| Issue | Task | Labels |
|-------|------|--------|
| #33 | Implement protected-sections.manifest | `phase:hardening` `type:security` `priority:high` |
| #34 | Write and test runner-side pre-merge hook | `phase:hardening` `type:security` `priority:high` |
| #35 | Add machine-checked guardrails for auth/money/network | `phase:hardening` `type:security` `priority:high` |
| #36 | Set up integration with existing SaaS products | `phase:hardening` `type:setup` `priority:medium` |

---

## Week 8 (May 4–10) — Production Readiness

**Goal:** Full system drill. Failure recovery documented. Ready to run unsupervised.

| Issue | Task | Labels |
|-------|------|--------|
| #37 | Create monitoring dashboard for agent activity | `phase:hardening` `type:feature` `priority:medium` |
| #38 | Document failure recovery procedures | `phase:hardening` `type:documentation` `priority:high` |
| #39 | Write integration tests for inter-agent loops | `phase:hardening` `type:testing` `priority:high` |
| #40 | Write hallucination mitigation tests | `phase:hardening` `type:testing` `priority:medium` |
| #41 | Run full system drill: standup → delegation → peer review → lesson → Improver | `phase:hardening` `type:testing` `priority:high` |

---

## Post-Launch (May 11+) — Milestone 5

| Task |
|------|
| Add CEO agent (strategy & market signals) |
| Add CFO agent (financial planning) |
| Add Lawyer agent (compliance & legal) |
| Add CTO agent (architecture & DevOps) |
| Evaluate event bus vs. trigger table approach |
| Build agent activity analytics dashboard |
| Expand to handle 5+ products |
