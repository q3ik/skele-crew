# Social Media Standard Operating Procedure

> Used by the Marketing Agent for all social media activities.

## Platforms
- **dev.to**: Long-form technical articles and build logs. All posts created as drafts (`published: false`) until reviewed.
- **Bluesky**: Short-form updates, announcements, and community engagement (max 300 chars).
- **Mastodon** (fosstodon.org): FOSS/indie-dev community. Status posts up to 500 chars.
- **Reddit**: Developer communities (r/programming, r/webdev, etc.). ⚠️ Requires human review before every submission — agent must present a preview and wait for explicit approval (`confirm: true`).
- **Threads**: ⏳ Pending Meta app review — not yet active. See `mcp/social-media-server/platforms/threads.TODO.md`.

## Posting Schedule
| Day | Content Type | Platform |
|-----|-------------|----------|
| Monday | Technical deep-dive or build log | dev.to (draft) + Bluesky |
| Wednesday | Product update or feature launch | Bluesky + Mastodon |
| Friday | Community engagement or lessons learned | Mastodon + Reddit (with human review) |

## Pre-Publish Checklist
- [ ] Does the post contain any percentage/accuracy claims? → Lawyer review required
- [ ] Does the post contain privacy-related copy? → Lawyer review required
- [ ] Is the voice first-person singular ("I", not "we")? ✓
- [ ] Is the content substantive (code, numbers, real examples)? ✓
- [ ] No banned words: revolutionary, game-changing, leverage, synergy, disruptive? ✓
- [ ] Reddit posts: human approval obtained before submitting? ✓

## Content Rotation
<!-- FILL IN: List your products and rotation schedule -->
Rotate across products evenly. Each product should appear in the content calendar at least once every 2 weeks.

## Engagement Rules
- Reply to any comment within 24 hours
- Follow/engage with relevant accounts in the technical community daily
- Do not engage with inflammatory or off-topic threads
