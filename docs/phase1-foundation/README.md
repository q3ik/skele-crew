# Phase 1: Foundation (Weeks 1–2)

> Milestone due: March 30, 2026

## Objective
Stand up the core infrastructure: repo structure, MCP servers, shared memory, and the first 3 agent files (COO, Marketing, Accountant). At the end of Week 2, you should be able to run a COO standup manually and have it update BOARD.md.

## Repo Structure

```
skele-crew/
├── .github/
│   ├── agents/
│   │   ├── coo.agent.md
│   │   ├── marketing.agent.md
│   │   └── accountant.agent.md
│   ├── copilot-instructions.md      # Global company identity
│   ├── skills/
│   │   └── ontario-canada-tax/SKILL.md
│   └── instructions/
│       └── marketing.instructions.md
├── memory/
│   └── knowledge-graph.jsonl        # Shared memory store
├── Marketing/
│   ├── social-media-sop.md
│   ├── drafts/
│   └── social-media-strategy-2026.md
├── BOARD.md                         # COO-maintained sprint board
└── ops/
    └── protected-sections.manifest  # Guardrail definitions
```

## MCP Servers to Set Up

| MCP Server | Purpose | Option |
|-----------|---------|--------|
| Memory / knowledge graph | Shared agent state | `@modelcontextprotocol/server-memory` (fork for mutex) |
| Scheduling | Periodic task triggers | `@modelcontextprotocol/server-scheduler` or cron |
| Social media | Post to X, dev.to | Official X MCP or custom wrapper |
| Monitoring | Error ingestion | Sentry MCP or REST wrapper |

### Critical: Memory Server Hardening

Fork the upstream MCP memory server and add **before any agent writes**:
1. Async mutex around `saveGraph()` — prevents concurrent write corruption
2. Atomic writes (write to `.tmp`, then `os.replace()`) — prevents partial writes
3. Auto-repair on load (skip corrupt lines, deduplicate by key) — prevents startup failures

```python
import asyncio, json, os

_graph_lock = asyncio.Lock()

async def save_graph(entities, relations, path="memory/knowledge-graph.jsonl"):
    async with _graph_lock:
        lines = [json.dumps(e) for e in entities + relations]
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            f.write("\n".join(lines))
        os.replace(tmp, path)  # atomic rename

def load_graph_safe(path):
    entities, relations = [], []
    seen = set()
    with open(path) as f:
        for line in f:
            try:
                obj = json.loads(line.strip())
                key = (obj.get("type"), obj.get("name", obj.get("from","")))
                if key not in seen:
                    seen.add(key)
                    (entities if obj["type"]=="entity" else relations).append(obj)
            except json.JSONDecodeError:
                pass  # skip corrupt lines
    return entities, relations
```

## Knowledge Graph Schema

### Entity Types
- `product` — Your SaaS products
- `decision` — Strategic decisions with rationale
- `deadline` — Tax, legal, product deadlines
- `client` — Client or customer data
- `metric` — KPIs, citation tracking, performance data
- `lesson` — Learned lessons from mistakes or incidents (permanent)

### Relation Types
- `owns` — agent owns product
- `uses` — product uses service
- `built-with` — product built with technology
- `depends-on` — cross-product dependency

### Retention Rules
- `standup` entities: prune after 7 days
- `lesson`, `decision`, `deadline` entities: permanent
- `metric` entities: archive after 90 days (keep summary)

## copilot-instructions.md Requirements

This file is loaded into every Copilot interaction. It must define:
- Company identity (who you are, what you build)
- Product registry (all products with stack and status)
- Agent system overview (where agents live, what they do)
- Memory protocol (read graph at start, write lessons after mistakes)
- Inter-agent rules (max depth 3, no callbacks, chain tracking)
- Hard boundaries (financial, legal, auth — never modified by agents)

## Week 1 Checklist

- [ ] Create management repo with `.github/agents/` structure
- [ ] Write `copilot-instructions.md` (company identity, product registry, protocols)
- [ ] Fork and harden MCP memory server (mutex + atomic writes + auto-repair)
- [ ] Set up Sentry MCP (or REST wrapper)
- [ ] Initialize `knowledge-graph.jsonl` with your products as entities
- [ ] Write `COO.agent.md` (standup sequence, delegation rules)

## Week 2 Checklist

- [ ] Write `Marketing.agent.md` (voice/tone, autonomous execution, Lawyer trigger)
- [ ] Write `Accountant.agent.md` + jurisdiction tax SKILL.md
- [ ] Set up social media MCP (X + dev.to)
- [ ] Set up scheduler MCP
- [ ] Run first manual standup with COO; verify BOARD.md updates
- [ ] Verify Marketing→Lawyer peer review fires correctly on a test claim

## Risk Mitigation

| Risk | Prevention | Recovery |
|------|-----------|---------|
| Memory corruption from parallel writes | Async mutex + atomic writes | `.tmp` rollback; corrupt lines skipped |
| Agents hallucinating product details | Populate knowledge graph before running agents | Add lesson entity; run Improver cycle |
| copilot-instructions.md too long for context | Keep concise; link to docs/ for detail | Split into modular instruction files |

## Success Criteria for Milestone 1

- [ ] COO can run a manual standup and produce a valid BOARD.md entry
- [ ] Marketing agent drafts a post and correctly triggers Lawyer review for any claims
- [ ] Accountant agent writes a deadline entity to knowledge-graph.jsonl
- [ ] Memory server starts cleanly even with intentionally corrupt JSONL lines
- [ ] All 3 agent files have the consultation heuristic fallback
