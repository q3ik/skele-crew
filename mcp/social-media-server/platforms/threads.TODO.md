# Threads Platform — Investigation Notes (TODO)

> Status: **Not implemented** — Meta API requires app review approval before access is granted.
> Last reviewed: 2026-03-16

## Overview

Threads is Meta's text-based social network. The API is available but requires
formal app review before a developer can post programmatically.

## API Reference

- Official docs: <https://developers.facebook.com/docs/threads>
- Base URL: `https://graph.threads.net/v1.0/`
- Auth: OAuth 2.0 (similar to Instagram Graph API)

## What's Needed to Unlock Access

1. **Create a Meta developer app** at <https://developers.facebook.com/apps/>
2. Add the **Threads API** product to the app.
3. Submit the app for **App Review** — required for the `threads_basic` and
   `threads_content_publish` permissions.
4. Once approved, generate a **long-lived access token** (valid 60 days; refresh
   before expiry).
5. Add env vars: `THREADS_USER_ID`, `THREADS_ACCESS_TOKEN`.

## Planned Tool Signature (post-approval)

```typescript
threads_post(text: string): Promise<{ id: string } | { error: string }>
```

Two-step publish flow:
1. `POST /{user-id}/threads` with `media_type=TEXT` and `text=…` → get `creation_id`
2. `POST /{user-id}/threads_publish` with `creation_id` → publishes the post

## Rate Limits

- 250 posts per 24 hours per user.
- Replies and reposts count separately.

## Action Items

- [ ] Apply for Meta app review with `threads_content_publish` permission
- [ ] Once approved, implement `platforms/threads.ts` following the pattern
      established by `devto.ts`, `bluesky.ts`, and `mastodon.ts`
- [ ] Add `THREADS_USER_ID` and `THREADS_ACCESS_TOKEN` to `.env.example`
- [ ] Register the `threads_post` tool in `index.ts`
