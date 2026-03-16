# Phase 4: Hardening & Production (Weeks 7–8)

> Milestone due: May 11, 2026

## Objective
Machine-enforce the guardrails. Run the full system end-to-end. Document failure recovery. The system should be capable of running unsupervised for at least a week without human intervention beyond reviewing PROPOSED_CHANGES.md.

## Protected Sections Manifest

File: `ops/protected-sections.manifest`

```yaml
protected_blocks:
  - tag: "PROTECTED: financial-thresholds"
    files: ["accountant.agent.md", "cfo.agent.md"]
    enforcement: block-merge

  - tag: "PROTECTED: legal-compliance"
    files: ["lawyer.agent.md", "accountant.agent.md"]
    enforcement: block-merge

  - tag: "PROTECTED: auth-logic"
    files: ["cto.agent.md"]
    enforcement: block-merge

runner_checks:
  - on: pre-merge
    action: diff-against-manifest
    on_violation: auto-reject
```

## Pre-merge Hook

**Critical principle**: This runs on the CI runner, not inside an agent. Agents cannot validate their own output — that's the whole point.

File: `.github/hooks/pre-merge-check.sh`

```bash
#!/bin/bash
MANIFEST="ops/protected-sections.manifest"
PROPOSED="PROPOSED_CHANGES.md"

for tag in $(grep -oP '(?<=tag: ").*(?=")' $MANIFEST); do
  if grep -q "$tag" "$PROPOSED"; then
    echo "BLOCKED: Proposed change touches protected section: $tag"
    exit 1
  fi
done
echo "PASS: No protected sections modified"
```

Wire this into your CI pipeline (GitHub Actions):
```yaml
# .github/workflows/protect-agents.yml
name: Protected Sections Check
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bash .github/hooks/pre-merge-check.sh
```

## Machine-Checked Guardrails

### Financial Guardrails
- No agent may generate payment instructions without a human-authored approval entity in the knowledge graph
- Any entity with `entityType: payment` or `entityType: invoice` is read-only for agents
- Threshold changes in accountant/cfo agent files require manual PR + pre-merge bypass

### Auth Guardrails
- CTO agent cannot propose changes to auth logic sections
- Any PR touching `<!-- PROTECTED: auth-logic -->` is auto-rejected

### Network/Production Guardrails
- MCP servers should have read-only access to production databases unless explicitly scoped
- Deployment hooks called by agents must require a human-authored `decision` entity as prerequisite

## Integration with Existing Products

### Agent Access to Product Data
Via environment variables in the MCP server configuration:
```
PRODUCT_SAAS_A_API_KEY=...
PRODUCT_SAAS_A_SENTRY_DSN=...
PRODUCT_SAAS_A_DB_READONLY_URL=...
```

Agents read product data through MCP tool calls, never direct DB access.

### Deployment Pipeline Hooks
- COO can trigger a deployment by writing a `decision` entity with `type: deploy`
- CI/CD pipeline reads the knowledge graph for this entity and executes
- Human must create the decision entity; COO cannot auto-deploy

## Failure Recovery Procedures

| Failure Mode | Symptoms | Recovery |
|-------------|----------|---------|
| Agent hallucination | Claim made without data | Log lesson entity; Improver patches trigger table |
| Memory corruption | JSON parse errors on load | `load_graph_safe` skips bad lines; check `.tmp` backup |
| Infinite agent loop | Depth counter > 3 | Chain header auto-blocks; log lesson; check trigger tables |
| Financial/legal drift | Protected section in PROPOSED_CHANGES | Pre-merge hook auto-rejects; human reviews diff |
| Context window overflow | Agent response truncated | Delegate data-gathering to subtasks; summarize before passing |
| Behavioral drift | Same task in 3+ standups | COO coach fires; escalate to human; break task into subtasks |
| MCP server down | Agent can't read/write memory | Fall back to last known state in `.tmp`; restart MCP server |

## Weeks 7–8 Checklist

### Week 7
- [ ] Create `protected-sections.manifest`
- [ ] Write and test pre-merge hook script
- [ ] Wire pre-merge hook into GitHub Actions workflow
- [ ] Add machine-checked guardrails for auth/money/network
- [ ] Set up integration with existing SaaS products (env vars, MCP config)

### Week 8
- [ ] Create monitoring dashboard for agent activity (knowledge graph query)
- [ ] Document failure recovery procedures for each known failure mode
- [ ] Write integration tests for inter-agent loops
- [ ] Write hallucination mitigation tests
- [ ] Run full system drill: standup → delegation → peer review → lesson → Improver cycle
- [ ] Confirm: zero protected section violations get through pre-merge hook

## Success Criteria for Milestone 4

- [ ] Full system drill completes without errors
- [ ] Pre-merge hook auto-rejects a test PR touching a protected section
- [ ] Agent hallucination test: Marketing makes a metric claim → Lawyer is consulted → lesson is logged
- [ ] Memory server survives simulated corruption (test with intentional bad JSONL lines)
- [ ] Failure recovery procedures documented for all 7 failure modes
- [ ] System can run for 3 days without human intervention beyond reviewing PROPOSED_CHANGES.md

## Safety Architecture Summary

| Threat | Prevention | Recovery |
|--------|-----------|---------|
| Agent hallucination | Mandatory peer review for claims/decisions | Lesson entity logged; Improver patches |
| Memory corruption | Async mutex + atomic writes + auto-repair | `.tmp` file rollback; corrupt lines skipped |
| Infinite agent loops | Call-chain tracking, max depth 3, no-callback rule | Chain header auto-blocks recursive calls |
| Financial/legal drift | Protected sections manifest + runner-side diff check | Auto-reject on violation; human reviews PROPOSED_CHANGES.md |
| Context window overflow | Agents delegate data-gathering to subagents | Break tasks into bounded subtasks |
| Behavioral drift | COO coach check every 3 cycles | Flags carry-over tasks; escalates to human |
