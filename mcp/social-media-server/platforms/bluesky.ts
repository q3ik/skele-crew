/**
 * Bluesky platform module
 *
 * API: AT Protocol via https://bsky.social/xrpc/
 * Auth: identifier + app password (NOT account password)
 * Env vars: BSKY_IDENTIFIER, BSKY_APP_PASSWORD
 */

const BSKY_API_BASE = 'https://bsky.social/xrpc';
const MAX_POST_LENGTH = 300;

export interface BlueskyPostParams {
  text: string;
}

export interface BlueskyPostResult {
  uri: string;
  cid: string;
}

export interface BlueskyError {
  error: string;
  status: number;
}

export type BlueskyCreateResult =
  | { success: true; data: BlueskyPostResult }
  | { success: false; error: BlueskyError };

interface AtpSession {
  accessJwt: string;
  did: string;
}

/**
 * Authenticate with Bluesky and return an access token + DID.
 */
async function createSession(identifier: string, appPassword: string): Promise<AtpSession> {
  const response = await fetch(`${BSKY_API_BASE}/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password: appPassword }),
  });

  if (!response.ok) {
    let errorBody = '';
    try { errorBody = await response.text(); } catch { /* ignore */ }
    throw new Error(`Bluesky auth failed (${response.status}): ${errorBody || response.statusText}`);
  }

  const data = await response.json() as AtpSession;
  return data;
}

/**
 * Post a text record to Bluesky.
 * Text must be ≤ 300 characters.
 */
export async function blueskyPost(
  params: BlueskyPostParams,
  identifier: string = process.env['BSKY_IDENTIFIER'] ?? '',
  appPassword: string = process.env['BSKY_APP_PASSWORD'] ?? '',
): Promise<BlueskyCreateResult> {
  if (!identifier) {
    return {
      success: false,
      error: { error: 'BSKY_IDENTIFIER environment variable is not set', status: 0 },
    };
  }
  if (!appPassword) {
    return {
      success: false,
      error: { error: 'BSKY_APP_PASSWORD environment variable is not set', status: 0 },
    };
  }

  const text = params.text.slice(0, MAX_POST_LENGTH);

  let session: AtpSession;
  try {
    session = await createSession(identifier, appPassword);
  } catch (err) {
    return {
      success: false,
      error: {
        error: err instanceof Error ? err.message : String(err),
        status: 0,
      },
    };
  }

  const record = {
    $type: 'app.bsky.feed.post',
    text,
    createdAt: new Date().toISOString(),
  };

  let response: Response;
  try {
    response = await fetch(`${BSKY_API_BASE}/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.accessJwt}`,
      },
      body: JSON.stringify({
        repo: session.did,
        collection: 'app.bsky.feed.post',
        record,
      }),
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

  const data = await response.json() as BlueskyPostResult;
  return { success: true, data };
}
