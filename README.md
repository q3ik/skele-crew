# skele-crew

> AI Agent Company infrastructure for a solo founder — 8 virtual departments powered by GitHub Copilot custom agents, a shared knowledge graph, and MCP servers.

[![Milestone 1](https://img.shields.io/github/milestones/progress/q3ik/skele-crew/1?label=Foundation)](https://github.com/q3ik/skele-crew/milestone/1)
[![Milestone 2](https://img.shields.io/github/milestones/progress/q3ik/skele-crew/2?label=Communication)](https://github.com/q3ik/skele-crew/milestone/2)
[![Milestone 3](https://img.shields.io/github/milestones/progress/q3ik/skele-crew/3?label=Advanced)](https://github.com/q3ik/skele-crew/milestone/3)
[![Milestone 4](https://img.shields.io/github/milestones/progress/q3ik/skele-crew/4?label=Hardening)](https://github.com/q3ik/skele-crew/milestone/4)

## What This Is

A management repo that runs a virtual company. Every department is an AI agent (`.agent.md` file). Agents share memory via a JSONL knowledge graph, consult each other through a structured peer-review protocol, and self-improve via the Improver agent.

Inspired by [João Pedro Silva Setas's article](https://dev.to/joaopedrosetas/i-run-a-solo-company-with-ai-agent-departments-4ho5).

## Agent Roster

| Agent | Role | Status |
|-------|------|--------|
| COO | Operations & daily standup orchestration (uses scheduler to flag overdue periodic prompts) | 🔴 Planned |
| Marketing | Content, social media, voice/tone | 🔴 Planned |
| Accountant | Tax compliance, fiscal deadlines | 🔴 Planned |
| Improver | Self-improvement meta-agent | 🔴 Planned |
| CEO | Strategy & market signals | 🔴 Post-launch |
| CFO | Financial planning & pricing | 🔴 Post-launch |
| Lawyer | Compliance & legal review | 🔴 Post-launch |
| CTO | Architecture & DevOps decisions | 🔴 Post-launch |

## Repo Structure

```
skele-crew/
├── .github/
│   ├── agents/                    # Agent .agent.md files
│   ├── copilot-instructions.md    # Company constitution (loaded into all Copilot sessions)
│   ├── skills/                    # Reusable skill modules
│   │   └── jurisdiction-tax/SKILL.md
│   ├── instructions/              # Agent-specific instruction files
│   └── hooks/                     # Runner-side pre-merge checks
├── memory/
│   └── knowledge-graph.jsonl      # Shared persistent memory (ALL agents read/write here)
├── Marketing/
│   ├── social-media-sop.md
│   ├── social-media-strategy-2026.md
│   └── drafts/
├── ops/
│   └── protected-sections.manifest
├── docs/
│   ├── phase1-foundation/
│   ├── phase2-communication/
│   ├── phase3-advanced/
│   └── phase4-hardening/
├── BOARD.md                       # COO-maintained sprint board
├── PROPOSED_CHANGES.md            # Improver proposals awaiting human review
├── TEMPLATES.md                   # Agent and skill file templates
├── CONTRIBUTING.md                # How to work in this repo
└── TIMELINE.md                    # 8-week implementation roadmap
```

## 8-Week Implementation Plan

| Week | Phase | Key Deliverables |
|------|-------|-----------------|
| 1–2 | Foundation | Repo structure, MCP servers, COO/Marketing/Accountant agents, copilot-instructions.md |
| 3–4 | Communication & Memory | Inter-agent protocol, knowledge graph hardening, citation tracking |
| 5–6 | Advanced Features | Standup automation, Improver agent, COO coach |
| 7–8 | Hardening & Production | Protected sections, pre-merge hooks, full system drill |

## Getting Started

1. Read [CONTRIBUTING.md](./CONTRIBUTING.md) for the working process
2. Review [TIMELINE.md](./TIMELINE.md) for the week-by-week plan
3. Check the [GitHub Project board](https://github.com/orgs/q3ik/projects) for current status
4. Start with the Foundation milestone issues

## Key Design Principles

1. **Start with 3 agents** — COO, Marketing, Accountant cover ~80% of value
2. **Invest in memory early** — knowledge graph compounds over time
3. **Hard boundaries on money, legal, auth** — agents never modify these autonomously
4. **Human judgment at critical points** — strategic pivots, financial approvals, legal submissions
5. **Peer review as safety net** — agents validate each other before acting on claims
