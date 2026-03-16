# Phase 2: Agent Communication & Memory (Weeks 3–4)

> Milestone due: April 13, 2026

## Objective
Implement the inter-agent protocol, harden the knowledge graph with write-contention handling, add citation tracking, and make the system multi-product aware. By end of Week 4, agents should be consulting each other correctly with no infinite loops.

## Inter-Agent Protocol

### Call-Chain Tracking
Every peer review request must include this header:

```markdown
## Peer Review Request
**From**: [Agent Name]
**Call chain**: [e.g., COO → Marketing → Lawyer] ← append yourself here
**Depth**: [current depth, max 3]
**Task**: [what the calling agent is working on]
**What I did**: [specific output or decision]
**What I need from you**: [specific question]

Respond with exactly one of:
- ✅ APPROVED — [brief rationale]
- ⚠️ CONCERNS — [what needs changing]
- 🚫 BLOCKING — [what is non-negotiable and why]
```

### No-Callback Rule
If Agent X is in the call chain, Agent Y cannot call Agent X back, even if the question is relevant. Agents must operate with their current context.

Example: `COO → CFO → Accountant` — Accountant CANNOT call CFO back.

### Trigger Table (encode in each agent file)

| Calling Agent | Trigger Condition | Must Consult |
|--------------|-------------------|--------------|
| Marketing | Any metric/accuracy claim | Lawyer |
| CFO | Pricing decision | Accountant |
| CTO | Infrastructure cost change | CFO |
| COO | Legal compliance question | Lawyer |
| Any | Cross-product impact | COO |

### Consultation Heuristic Fallback
Add to every agent file:
```markdown
## Consultation Heuristic
If your output involves: money amounts, legal claims, auth systems, or cross-product
changes → pause and request peer review before acting, even if no explicit trigger fires.
```

## Knowledge Graph Hardening

See Phase 1 docs for the `save_graph` / `load_graph_safe` implementation.

### Citation Tracking
Track which entities are actually being used by agents to identify stale data:

```jsonl
{"type":"entity","name":"metric:citation-tracking:2026-03","entityType":"metric",
  "observations":["entity:product:my-saas:cited:14","entity:deadline:Q2-tax:cited:3",
  "entity:lesson:2026-02:memory-corruption:cited:0","last_updated:2026-03-15"]}
```

Implementation: wrap the MCP memory read tool to log entity names that appear in agent responses. After 30 sessions, entities with `cited:0` can have refresh intervals extended.

### Memory Pruning
Run as a COO standup task (weekly):
- Delete standup entities older than 7 days
- Keep all `lesson`, `decision`, `deadline` entities permanently
- Archive `metric` entities older than 90 days (keep summary entity)

### Multi-Product Namespace
Each product gets a namespace prefix: `product:saas-a:*` vs `product:saas-b:*`.

The `copilot-instructions.md` product registry defines which agent has read/write scope for each product's entities. Cross-product relations use `depends-on` typed edges.

## Weeks 3–4 Checklist

### Week 3
- [ ] Implement call-chain tracking in all agent files
- [ ] Add no-callback rule enforcement to agent instructions
- [ ] Implement peer review request/response format
- [ ] Encode trigger table in each agent file
- [ ] Add consultation heuristic fallback to all agents

### Week 4
- [ ] Test write contention with parallel agent calls
- [ ] Implement citation tracking wrapper on memory reads
- [ ] Add multi-product namespace to knowledge graph
- [ ] Implement memory pruning (standups >7 days)
- [ ] Write unit tests for memory server (load, save, auto-repair, dedup)

## Risk Mitigation

| Risk | Prevention | Recovery |
|------|-----------|---------|
| Infinite agent loops | Call-chain tracking + max depth 3 + no-callback | Chain header auto-blocks recursive calls |
| Agents not knowing when to consult | Trigger tables + consultation heuristic | Review lessons from missed consultations; update trigger tables |
| Graph growing too large | Retention rules + pruning | Periodic pruning script; archive old entities |

## Success Criteria for Milestone 2

- [ ] Marketing→Lawyer peer review fires for any metric claim, respects max depth
- [ ] Two parallel agent calls complete without corrupting knowledge-graph.jsonl
- [ ] Citation tracking metric entity updated after each standup cycle
- [ ] Memory pruning removes 7-day-old standup entities correctly
- [ ] All agents have trigger tables and consultation heuristic
