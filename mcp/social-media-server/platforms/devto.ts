/**
 * dev.to platform module
 *
 * API: POST https://dev.to/api/articles
 * Auth: api-key header from env var DEVTO_API_KEY
 * Default: published = false (always draft first)
 */

export interface DevtoArticleParams {
  title: string;
  body_markdown: string;
  tags?: string[];
  published?: boolean;
}

export interface DevtoArticleResult {
  id: number;
  url: string;
  title: string;
  published: boolean;
}

export interface DevtoError {
  error: string;
  status: number;
}

export type DevtoCreateResult =
  | { success: true; data: DevtoArticleResult }
  | { success: false; error: DevtoError };

const DEVTO_API_BASE = 'https://dev.to/api';

/**
 * Create an article on dev.to.
 * Defaults to published=false (draft) unless explicitly set to true.
 */
export async function devtoCreateArticle(
  params: DevtoArticleParams,
  apiKey: string = process.env['DEVTO_API_KEY'] ?? '',
): Promise<DevtoCreateResult> {
  if (!apiKey) {
    return {
      success: false,
      error: { error: 'DEVTO_API_KEY environment variable is not set', status: 0 },
    };
  }

  const payload = {
    article: {
      title: params.title,
      body_markdown: params.body_markdown,
      tags: params.tags ?? [],
      published: params.published ?? false,
    },
  };

  let response: Response;
  try {
    response = await fetch(`${DEVTO_API_BASE}/articles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify(payload),
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
    try {
      errorBody = await response.text();
    } catch {
      // ignore
    }
    return {
      success: false,
      error: { error: errorBody || response.statusText, status: response.status },
    };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    return {
      success: false,
      error: {
        error: `Failed to parse response JSON: ${err instanceof Error ? err.message : String(err)}`,
        status: response.status,
      },
    };
  }

  const data = json as DevtoArticleResult;
  return { success: true, data };
}
