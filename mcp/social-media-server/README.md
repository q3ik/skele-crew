# Social Media MCP Server

MCP server that exposes social media posting tools for the Marketing agent.

## Supported Platforms

| Platform | Tool | Status |
|---|---|---|
| **dev.to** | `devto_create_article` | ✅ Implemented |
| **Bluesky** | `bluesky_post` | ✅ Implemented |
| **Mastodon** | `mastodon_post` | ✅ Implemented |
| **Reddit** | `reddit_submit` | ✅ Implemented (human-review guardrail) |
| **Threads** | — | ⏳ Pending Meta app review — see `platforms/threads.TODO.md` |

## Setup

### 1. Install dependencies

```bash
cd mcp/social-media-server
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Configure environment variables

Copy `.env.example` at the repo root and fill in values:

```bash
cp .env.example .env
# Edit .env with your credentials
```

See the **Platform Auth** section below for how to obtain each credential.

### 4. Run locally

```bash
node dist/index.js
```

Or via the MCP SDK transport of your choice.

---

## Platform Auth

### dev.to

1. Log in to [dev.to](https://dev.to)
2. Go to **Settings → Account → DEV API Keys**
3. Generate a new key and copy it
4. Set `DEVTO_API_KEY=<your-key>` in your `.env`

**Default behaviour:** All articles are created as **drafts** (`published: false`)
unless the `published` parameter is explicitly set to `true`.

---

### Bluesky

> ⚠️ Use an **app password**, not your main account password.

1. Log in to [bsky.app](https://bsky.app)
2. Go to **Settings → Privacy and Security → App Passwords**
3. Click **Add App Password**, give it a name (e.g. `skele-crew`), copy the password
4. Set the following env vars:

```
BSKY_IDENTIFIER=yourhandle.bsky.social   # or your custom domain handle
BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

---

### Mastodon

> Instance recommendation: [fosstodon.org](https://fosstodon.org) for dev/tech content.

1. Log in to your Mastodon instance
2. Go to **Preferences → Development → New Application**
3. Give it a name and grant `write:statuses` scope
4. Copy the **Access Token**
5. Set the following env vars:

```
MASTODON_INSTANCE_URL=https://fosstodon.org
MASTODON_ACCESS_TOKEN=<your-access-token>
```

---

### Reddit

> ⚠️ Human review is required before any post is submitted. See the guardrail section below.

1. Go to [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps)
2. Click **Create Another App**, select **Script** type
3. Fill in name and redirect URI (use `http://localhost`)
4. Note the **client ID** (below the app name) and **client secret**
5. Set the following env vars:

```
REDDIT_CLIENT_ID=<client-id>
REDDIT_CLIENT_SECRET=<client-secret>
REDDIT_USERNAME=<your-reddit-username>
REDDIT_PASSWORD=<your-reddit-password>
```

#### Human-Review Guardrail

The `reddit_submit` tool enforces mandatory human review:

- Without `confirm: true`, the tool **returns a preview only** and does not post.
- The agent must show the preview to the user and wait for explicit approval.
- Only after re-calling with `confirm: true` will the post be submitted.

---

### Threads

Threads API requires Meta app review. See
[`platforms/threads.TODO.md`](platforms/threads.TODO.md) for investigation notes
and action items.

---

## Tools Reference

### `devto_create_article`

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `title` | string | ✅ | — | Article title |
| `body_markdown` | string | ✅ | — | Article body (Markdown) |
| `tags` | string[] | ❌ | `[]` | Up to 4 tags |
| `published` | boolean | ❌ | `false` | Publish immediately if `true` |

---

### `bluesky_post`

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `text` | string | ✅ | — | Post text (max 300 chars; longer text is truncated) |

---

### `mastodon_post`

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `status` | string | ✅ | — | Status text |
| `visibility` | `public` \| `unlisted` \| `private` \| `direct` | ❌ | `public` | Post visibility |

---

### `reddit_submit`

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `subreddit` | string | ✅ | — | Target subreddit (without `r/` prefix) |
| `title` | string | ✅ | — | Post title |
| `text` | string | ✅ | — | Post body (Markdown) |
| `confirm` | boolean | ❌ | `false` | **Must be `true` to actually post** |

---

## Testing

```bash
npm test
```

Tests mock all HTTP calls — no real credentials or network access required.
