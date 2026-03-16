/**
 * Reddit platform module
 *
 * API: POST https://oauth.reddit.com/api/submit
 * Auth: OAuth2 script app
 * Env vars: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD
 *
 * ⚠️ HUMAN-REVIEW GUARDRAIL:
 * The `reddit_submit` tool requires `confirm: true` to actually post.
 * Without it, the tool returns a preview payload only — no post is made.
 * This is intentional to prevent autonomous agent submissions.
 */

export interface RedditSubmitParams {
  subreddit: string;
  title: string;
  text: string;
  /** Must be explicitly set to `true` to actually submit. Without this the tool only returns a preview. */
  confirm?: boolean;
}

export interface RedditPreview {
  confirmed: false;
  preview: {
    subreddit: string;
    title: string;
    text: string;
    kind: 'self';
  };
  message: string;
}

export interface RedditSubmitResult {
  confirmed: true;
  id: string;
  url: string;
  name: string;
}

export interface RedditError {
  error: string;
  status: number;
}

export type RedditCreateResult =
  | { success: true; data: RedditPreview | RedditSubmitResult }
  | { success: false; error: RedditError };

const REDDIT_OAUTH_BASE = 'https://oauth.reddit.com';
const REDDIT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';

interface RedditToken {
  access_token: string;
  token_type: string;
}

async function getRedditToken(
  clientId: string,
  clientSecret: string,
  username: string,
  password: string,
): Promise<RedditToken> {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'password',
    username,
    password,
  });

  const response = await fetch(REDDIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'skele-crew-social-media-server/0.1.0',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    let errorBody = '';
    try { errorBody = await response.text(); } catch { /* ignore */ }
    throw new Error(`Reddit OAuth failed (${response.status}): ${errorBody || response.statusText}`);
  }

  return response.json() as Promise<RedditToken>;
}

/**
 * Submit a self-post (text post) to a subreddit.
 *
 * ⚠️ Requires `confirm: true` to actually post — without it returns a preview only.
 */
export async function redditSubmit(
  params: RedditSubmitParams,
  clientId: string = process.env['REDDIT_CLIENT_ID'] ?? '',
  clientSecret: string = process.env['REDDIT_CLIENT_SECRET'] ?? '',
  username: string = process.env['REDDIT_USERNAME'] ?? '',
  password: string = process.env['REDDIT_PASSWORD'] ?? '',
): Promise<RedditCreateResult> {
  // ── Human-review guardrail ──────────────────────────────────────────────────
  if (!params.confirm) {
    return {
      success: true,
      data: {
        confirmed: false,
        preview: {
          subreddit: params.subreddit,
          title: params.title,
          text: params.text,
          kind: 'self',
        },
        message:
          'HUMAN REVIEW REQUIRED: Re-call this tool with confirm=true to actually submit. ' +
          'Review the preview above before confirming.',
      },
    };
  }

  if (!clientId) {
    return { success: false, error: { error: 'REDDIT_CLIENT_ID environment variable is not set', status: 0 } };
  }
  if (!clientSecret) {
    return { success: false, error: { error: 'REDDIT_CLIENT_SECRET environment variable is not set', status: 0 } };
  }
  if (!username) {
    return { success: false, error: { error: 'REDDIT_USERNAME environment variable is not set', status: 0 } };
  }
  if (!password) {
    return { success: false, error: { error: 'REDDIT_PASSWORD environment variable is not set', status: 0 } };
  }

  let token: RedditToken;
  try {
    token = await getRedditToken(clientId, clientSecret, username, password);
  } catch (err) {
    return {
      success: false,
      error: { error: err instanceof Error ? err.message : String(err), status: 0 },
    };
  }

  const body = new URLSearchParams({
    sr: params.subreddit,
    title: params.title,
    text: params.text,
    kind: 'self',
    api_type: 'json',
  });

  let response: Response;
  try {
    response = await fetch(`${REDDIT_OAUTH_BASE}/api/submit`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token.access_token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'skele-crew-social-media-server/0.1.0',
      },
      body: body.toString(),
    });
  } catch (err) {
    return {
      success: false,
      error: {
        error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
        status: 0,
      },
    };
  }

  if (!response.ok) {
    let errorBody = '';
    try { errorBody = await response.text(); } catch { /* ignore */ }
    return {
      success: false,
      error: { error: errorBody || response.statusText, status: response.status },
    };
  }

  interface RedditApiResponse {
    json: { data: { id: string; url: string; name: string } };
  }
  const json = await response.json() as RedditApiResponse;
  const { id, url, name } = json.json.data;
  return { success: true, data: { confirmed: true, id, url, name } };
}
