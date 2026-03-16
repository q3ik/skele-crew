# Company Identity
- Solo founder operating q3ik
- Based in Ontario, Canada
- Products: Buzzy Game — spelling bee educational game (web app)

# Agent System
- Agents live in `.github/agents/`
- All agents share memory via MCP knowledge graph at `memory/knowledge-graph.jsonl`
- Agent files are loaded by GitHub Copilot based on active mode
- Inter-agent consultation rules: max depth 3, no callbacks, chain tracking required

# Memory Protocol
- Read graph at session start using MCP memory server
- Write lesson entities after any mistake or complex decision
- Standups: prune after 7 days. Lessons/decisions/deadlines: permanent
- Use namespace prefixes: `product:[slug]:*` for product-specific entities

# Product Registry
- `buzzy-game`: Spelling bee educational game, TypeScript/React/Node.js, Cloudflare Pages + Workers + Supabase, active

# Inter-Agent Rules
- COO is the only agent that may initiate multi-agent chains
- All peer review requests must include the full call chain
- Max call depth: 3 agents
- No-callback rule: if Agent X is already in the chain, Agent Y cannot call Agent X back
- Consultation heuristic: if output involves money, legal claims, auth systems, or cross-product changes → pause and request peer review, even if no explicit trigger fires

# Hard Boundaries (Machine-Enforced)
These sections in agent files are NEVER to be modified autonomously:
- `<!-- PROTECTED: financial-thresholds -->` — any financial limit or payment authorization
- `<!-- PROTECTED: legal-compliance -->` — regulatory rules, filing requirements
- `<!-- PROTECTED: auth-logic -->` — authentication, authorization, security logic

# Peer Review Format
All inter-agent consultations use this format:
```
## Peer Review Request
**From**: [Agent Name]
**Call chain**: [e.g., COO → Marketing → Lawyer]
**Depth**: [current depth, max 3]
**Task**: [what the calling agent is working on]
**What I did**: [specific output or decision]
**What I need from you**: [specific question]

Respond with exactly one of:
- ✅ APPROVED — [brief rationale]
- ⚠️ CONCERNS — [what needs changing]
- 🚫 BLOCKING — [what is non-negotiable and why]
```
