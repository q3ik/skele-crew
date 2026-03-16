# Templates

> Agent file templates, skill module templates, and reusable formats.

---

## Agent File Template (`.github/agents/[name].agent.md`)

```markdown
# [Agent Name] Agent

## Core Responsibilities
- [Primary responsibility 1]
- [Primary responsibility 2]
- [Primary responsibility 3]

## Domain Knowledge
- [Domain-specific knowledge this agent holds]
- Load skill: `.github/skills/[skill-name]/SKILL.md` for [domain]

## Autonomous Execution
- May: [list of permitted autonomous actions]
- CANNOT: [list of hard stops that require human or peer review]

<!-- PROTECTED: [relevant-protection-tag] -->
## Hard Boundaries (NEVER override)
- [Specific non-negotiable rule 1]
- [Specific non-negotiable rule 2]
<!-- END PROTECTED: [relevant-protection-tag] -->

## Trigger Conditions for Consulting [Other Agent]
- [Trigger 1]: consult [Agent]
- [Trigger 2]: consult [Agent]

## Peer Review Format (when sending to [Agent])
\`\`\`
**From**: [This Agent]
**Call chain**: [include full chain]
**Task**: [what you're working on]
**What I did**: [specific action]
**What I need**: [specific question]
Please respond: APPROVED / CONCERNS / BLOCKING
\`\`\`

## Consultation Heuristic
If output involves: [relevant high-risk domains for this agent] → pause and request peer review before acting, even if no explicit trigger fires.
```

---

## Skill Module Template (`.github/skills/[skill-name]/SKILL.md`)

```markdown
# [Skill Name]

> Brief description of what this skill covers and which agents use it.

## Overview
[Context: why this skill exists, what problem it solves]

## Key Rules / Knowledge
<!-- PROTECTED: legal-compliance --> (if applicable)
- [Rule 1]
- [Rule 2]
<!-- END PROTECTED -->

## Reference Data
| Category | Value | Notes |
|----------|-------|-------|
| | | |

## Filing / Deadline Calendar (if applicable)
| Item | Frequency | Due |
|------|-----------|-----|
| | | |

## External References
- [Official source 1](URL)
- [Official source 2](URL)
```

---

## Knowledge Graph Entity Templates

### Namespace Prefix Convention
- `product:[slug]:*` — e.g., `product:buzzy-game`
- `decision:[YYYY-MM-DD]:[short-description]`
- `deadline:[YYYY-QX]:[description]`
- `lesson:[YYYY-MM-DD]:[short-description]`

### Product Entity
```jsonl
{"type":"entity","name":"product:[slug]","entityType":"product","observations":["status: active|inactive","description: [brief]","stack: [tech]","deploy: [target]","url: [url]"]}
```

### Decision Entity
```jsonl
{"type":"entity","name":"decision:[YYYY-MM-DD]:[short-description]","entityType":"decision","observations":["choice: [what was decided]","rationale: [why]","agent: [who decided]","impact: [products/areas affected]"]}
```

### Deadline Entity
```jsonl
{"type":"entity","name":"deadline:[YYYY-QX]:[description]","entityType":"deadline","observations":["due: [YYYY-MM-DD]","owner: [agent]","status: pending|completed|missed","type: tax|legal|product"]}
```

### Lesson Entity
```jsonl
{"type":"entity","name":"lesson:[YYYY-MM-DD]:[short-description]","entityType":"lesson","observations":["category: bug|hallucination|missed-deadline|wrong-domain|scope-creep","agent: [who made the mistake]","summary: [what happened]","action: [what changed as a result]"]}
```

### Standup Entity (retention: 7 days)
```jsonl
{"type":"entity","name":"standup:[YYYY-MM-DD]","entityType":"standup","observations":["errors: [count]","overdue-tasks: [count]","delegations: [list]","priority-1: [task]"]}
```

### Retention Rules
- `standup` entities: prune after 7 days
- `lesson`, `decision`, `deadline` entities: permanent
- `metric` entities: archive after 90 days (keep summary)

### Metric Entity (citation tracking)
```jsonl
{"type":"entity","name":"metric:citation-tracking:[YYYY-MM]","entityType":"metric","observations":["entity:[name]:cited:[count]","last_updated:[YYYY-MM-DD]"]}
```

### Relation Templates
```jsonl
{"type":"relation","from":"product:[slug]","to":"service:[name]","relationType":"uses"}
{"type":"relation","from":"product:[slug-a]","to":"product:[slug-b]","relationType":"depends-on"}
{"type":"relation","from":"agent:[name]","to":"product:[slug]","relationType":"owns"}
```

---

## Peer Review Request Template

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

---

## Daily Standup Output Template

```markdown
# Daily Standup — [YYYY-MM-DD]

## Errors (Sentry)
- [product]: [error count] new issues — [severity: low|medium|high|critical]

## Sprint Board
- OVERDUE: [task] (due: [date], owner: [agent])
- IN PROGRESS: [task] (started: [date])

## Periodic Prompts Due
- [ ] Weekly review (overdue by [N] days)
- [x] Monthly accounting (completed [date])

## Delegations
- → [Agent]: [task description]
- → [Agent]: [task description]

## Today's Priority Plan
1. [Most critical item]
2. [Second priority]
3. [Third priority]

## Coach Check (if applicable)
- DRIFT DETECTED — [agent] committed to [action] on [date], no output found
```
