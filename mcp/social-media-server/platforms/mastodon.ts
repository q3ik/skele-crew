/**
 * Mastodon platform module
 *
 * API: POST https://<instance>/api/v1/statuses
 * Auth: OAuth2 access token
 * Env vars: MASTODON_INSTANCE_URL, MASTODON_ACCESS_TOKEN
 */

export type MastodonVisibility = 'public' | 'unlisted' | 'private' | 'direct';

export interface MastodonPostParams {
  status: string;
  visibility?: MastodonVisibility;
}

export interface MastodonStatusResult {
  id: string;
  url: string;
  content: string;
  visibility: MastodonVisibility;
}

export interface MastodonError {
  error: string;
  status: number;
}

export type MastodonCreateResult =
  | { success: true; data: MastodonStatusResult }
  | { success: false; error: MastodonError };

/**
 * Post a status to Mastodon.
 */
export async function mastodonPost(
  params: MastodonPostParams,
  instanceUrl: string = process.env['MASTODON_INSTANCE_URL'] ?? '',
  accessToken: string = process.env['MASTODON_ACCESS_TOKEN'] ?? '',
): Promise<MastodonCreateResult> {
  if (!instanceUrl) {
    return {
      success: false,
      error: { error: 'MASTODON_INSTANCE_URL environment variable is not set', status: 0 },
    };
  }
  if (!accessToken) {
    return {
      success: false,
      error: { error: 'MASTODON_ACCESS_TOKEN environment variable is not set', status: 0 },
    };
  }

  const base = instanceUrl.replace(/\/$/, '');

  let response: Response;
  try {
    response = await fetch(`${base}/api/v1/statuses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        status: params.status,
        visibility: params.visibility ?? 'public',
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

  const data = await response.json() as MastodonStatusResult;
  return { success: true, data };
}
