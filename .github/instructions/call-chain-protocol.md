# Call-Chain Protocol

> Canonical reference for inter-agent call-chain tracking.
> All agent files must link here and implement these rules.

## Rules

1. **Max depth 3.** COO = depth 1; agents called by COO = depth 2; their sub-calls = depth 3. No call may exceed depth 3.
2. **No-callback rule.** If an agent's name already appears in the call chain, it cannot be called again. Check the chain before every peer review request.
3. **COO only.** The COO is the only agent that may initiate a new multi-agent chain.
4. **Append yourself.** When passing the chain along, append your own name before forwarding.

## Peer Review Request Format

Every inter-agent consultation must use this exact format:

```markdown
## Peer Review Request
**From**: [Agent Name]
**Call chain**: [e.g., COO → Marketing → Lawyer]  *(append your own name before sending)*
**Depth**: [current depth, max 3]
**Task**: [what the calling agent is working on]
**What I did**: [specific output or decision]
**What I need from you**: [specific question]

Respond with exactly one of:
- ✅ APPROVED — [brief rationale]
- ⚠️ CONCERNS — [what needs changing]
- 🚫 BLOCKING — [what is non-negotiable and why]
```

## Pre-Call Checklist

Before making any peer review request, verify:
- [ ] My name does not appear in the current call chain (no-callback rule)
- [ ] The resulting depth will not exceed 3
- [ ] I am appending my name to the chain before forwarding
