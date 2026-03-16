/**
 * Unit tests for the social-media-server platform modules.
 *
 * All HTTP calls are intercepted via global fetch mocking so no real API
 * credentials or network access are required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { devtoCreateArticle } from '../platforms/devto.js';
import { blueskyPost } from '../platforms/bluesky.js';
import { mastodonPost } from '../platforms/mastodon.js';
import { redditSubmit } from '../platforms/reddit.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(...responses: Array<{ ok: boolean; status: number; body: unknown }>) {
  let call = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(call++, responses.length - 1)];
    return {
      ok: r.ok,
      status: r.status,
      statusText: r.ok ? 'OK' : 'Error',
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
      json: async () => r.body,
    } as unknown as Response;
  });
}

// ---------------------------------------------------------------------------
// dev.to tests
// ---------------------------------------------------------------------------

describe('devtoCreateArticle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns error when DEVTO_API_KEY is not provided', async () => {
    const result = await devtoCreateArticle(
      { title: 'Test', body_markdown: '# Hello' },
      '', // empty key
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.error).toMatch(/DEVTO_API_KEY/);
    }
  });

  it('creates a draft article (published=false by default)', async () => {
    const fakeResponse = { id: 123, url: 'https://dev.to/test/123', title: 'Test', published: false };
    vi.stubGlobal('fetch', mockFetch({ ok: true, status: 200, body: fakeResponse }));

    const result = await devtoCreateArticle(
      { title: 'Test', body_markdown: '# Hello' },
      'fake-api-key',
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.published).toBe(false);
      expect(result.data.id).toBe(123);
    }
  });

  it('creates a published article when published=true', async () => {
    const fakeResponse = { id: 124, url: 'https://dev.to/test/124', title: 'Test', published: true };
    vi.stubGlobal('fetch', mockFetch({ ok: true, status: 200, body: fakeResponse }));

    const result = await devtoCreateArticle(
      { title: 'Test', body_markdown: '# Hello', published: true },
      'fake-api-key',
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.published).toBe(true);
    }
  });

  it('returns error on non-OK HTTP response', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: false, status: 422, body: 'Unprocessable Entity' }));

    const result = await devtoCreateArticle(
      { title: 'Test', body_markdown: '# Hello' },
      'bad-key',
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.status).toBe(422);
    }
  });

  it('returns error on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network error'); }));

    const result = await devtoCreateArticle(
      { title: 'Test', body_markdown: '# Hello' },
      'fake-key',
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.error).toMatch(/network error/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Bluesky tests
// ---------------------------------------------------------------------------

describe('blueskyPost', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns error when BSKY_IDENTIFIER is not provided', async () => {
    const result = await blueskyPost({ text: 'Hello' }, '', 'some-password');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.error).toMatch(/BSKY_IDENTIFIER/);
    }
  });

  it('returns error when BSKY_APP_PASSWORD is not provided', async () => {
    const result = await blueskyPost({ text: 'Hello' }, 'user@example.com', '');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.error).toMatch(/BSKY_APP_PASSWORD/);
    }
  });

  it('posts successfully and returns uri + cid', async () => {
    const sessionResponse = { accessJwt: 'jwt-token', did: 'did:plc:abc123' };
    const recordResponse = { uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz', cid: 'cid123' };

    vi.stubGlobal(
      'fetch',
      mockFetch(
        { ok: true, status: 200, body: sessionResponse },
        { ok: true, status: 200, body: recordResponse },
      ),
    );

    const result = await blueskyPost({ text: 'Hello Bluesky!' }, 'user@bsky.social', 'app-password');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.uri).toBe(recordResponse.uri);
      expect(result.data.cid).toBe(recordResponse.cid);
    }
  });

  it('returns error when auth fails', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: false, status: 401, body: 'Unauthorized' }));

    const result = await blueskyPost({ text: 'Hello' }, 'user@bsky.social', 'wrong-password');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.error).toMatch(/401/);
    }
  });

  it('truncates text longer than 300 characters', async () => {
    const longText = 'a'.repeat(400);
    const sessionResponse = { accessJwt: 'jwt', did: 'did:plc:abc' };
    const recordResponse = { uri: 'at://did', cid: 'cid' };

    const fetchMock = mockFetch(
      { ok: true, status: 200, body: sessionResponse },
      { ok: true, status: 200, body: recordResponse },
    );
    vi.stubGlobal('fetch', fetchMock);

    await blueskyPost({ text: longText }, 'id', 'pass');

    // Second call is the createRecord — check that the body has ≤300 chars of text
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    const secondCallArgs = fetchMock.mock.calls[1];
    const body = JSON.parse(secondCallArgs[1].body as string);
    expect(body.record.text.length).toBeLessThanOrEqual(300);
  });
});

// ---------------------------------------------------------------------------
// Mastodon tests
// ---------------------------------------------------------------------------

describe('mastodonPost', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns error when MASTODON_INSTANCE_URL is not provided', async () => {
    const result = await mastodonPost({ status: 'Hello' }, '', 'token');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.error).toMatch(/MASTODON_INSTANCE_URL/);
    }
  });

  it('returns error when MASTODON_ACCESS_TOKEN is not provided', async () => {
    const result = await mastodonPost({ status: 'Hello' }, 'https://fosstodon.org', '');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.error).toMatch(/MASTODON_ACCESS_TOKEN/);
    }
  });

  it('posts successfully with default visibility=public', async () => {
    const fakeResponse = {
      id: '123456789',
      url: 'https://fosstodon.org/@testuser/123456789',
      content: 'Hello Mastodon!',
      visibility: 'public',
    };
    vi.stubGlobal('fetch', mockFetch({ ok: true, status: 200, body: fakeResponse }));

    const result = await mastodonPost(
      { status: 'Hello Mastodon!' },
      'https://fosstodon.org',
      'oauth-token',
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('123456789');
      expect(result.data.visibility).toBe('public');
    }
  });

  it('posts with unlisted visibility', async () => {
    const fakeResponse = {
      id: '999',
      url: 'https://fosstodon.org/@u/999',
      content: 'Hidden',
      visibility: 'unlisted',
    };
    vi.stubGlobal('fetch', mockFetch({ ok: true, status: 200, body: fakeResponse }));

    const result = await mastodonPost(
      { status: 'Hidden post', visibility: 'unlisted' },
      'https://fosstodon.org',
      'token',
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.visibility).toBe('unlisted');
    }
  });

  it('strips trailing slash from instance URL', async () => {
    const fakeResponse = { id: '1', url: 'https://fosstodon.org/@u/1', content: 'Hi', visibility: 'public' };
    const fetchMock = mockFetch({ ok: true, status: 200, body: fakeResponse });
    vi.stubGlobal('fetch', fetchMock);

    await mastodonPost({ status: 'Hi' }, 'https://fosstodon.org/', 'token');

    const [url] = fetchMock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe('https://fosstodon.org/api/v1/statuses');
  });
});

// ---------------------------------------------------------------------------
// Reddit tests
// ---------------------------------------------------------------------------

describe('redditSubmit', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns a preview (not a real post) when confirm is not set', async () => {
    const result = await redditSubmit(
      { subreddit: 'webdev', title: 'My Post', text: 'Hello!' },
    );

    expect(result.success).toBe(true);
    if (result.success && !('confirmed' in result.data && result.data.confirmed)) {
      const preview = result.data as { confirmed: false; preview: unknown; message: string };
      expect(preview.confirmed).toBe(false);
      expect(preview.message).toMatch(/HUMAN REVIEW/i);
    }
  });

  it('returns a preview when confirm=false explicitly', async () => {
    const result = await redditSubmit(
      { subreddit: 'webdev', title: 'My Post', text: 'Hello!', confirm: false },
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { confirmed: false };
      expect(data.confirmed).toBe(false);
    }
  });

  it('returns error when credentials are missing and confirm=true', async () => {
    const result = await redditSubmit(
      { subreddit: 'webdev', title: 'My Post', text: 'Hello!', confirm: true },
      '', // empty clientId
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.error).toMatch(/REDDIT_CLIENT_ID/);
    }
  });

  it('submits the post when confirm=true and credentials are present', async () => {
    const tokenResponse = { access_token: 'reddit-token', token_type: 'bearer' };
    const submitResponse = { json: { data: { id: 'abc', url: 'https://reddit.com/r/webdev/abc', name: 't3_abc' } } };

    vi.stubGlobal(
      'fetch',
      mockFetch(
        { ok: true, status: 200, body: tokenResponse },
        { ok: true, status: 200, body: submitResponse },
      ),
    );

    const result = await redditSubmit(
      { subreddit: 'webdev', title: 'My Post', text: 'Hello!', confirm: true },
      'client-id',
      'client-secret',
      'reddit-user',
      'reddit-pass',
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { confirmed: true; id: string };
      expect(data.confirmed).toBe(true);
      expect(data.id).toBe('abc');
    }
  });

  it('returns error on OAuth failure when confirm=true', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: false, status: 401, body: 'Unauthorized' }));

    const result = await redditSubmit(
      { subreddit: 'webdev', title: 'Post', text: 'Body', confirm: true },
      'id',
      'secret',
      'user',
      'pass',
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.error).toMatch(/401/);
    }
  });

  it('preview contains the subreddit, title, and text', async () => {
    const result = await redditSubmit({
      subreddit: 'programming',
      title: 'Interesting Title',
      text: 'Body content here',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      const preview = result.data as { confirmed: false; preview: { subreddit: string; title: string; text: string } };
      expect(preview.preview.subreddit).toBe('programming');
      expect(preview.preview.title).toBe('Interesting Title');
      expect(preview.preview.text).toBe('Body content here');
    }
  });
});
