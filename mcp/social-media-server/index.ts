#!/usr/bin/env node
/**
 * Social Media MCP Server
 *
 * Exposes posting tools for:
 *   - dev.to   (devto_create_article)
 *   - Bluesky  (bluesky_post)
 *   - Mastodon (mastodon_post)
 *   - Reddit   (reddit_submit — human-review guardrail enforced)
 *
 * Threads is not yet implemented; see platforms/threads.TODO.md.
 *
 * Credentials are read exclusively from environment variables — never hardcoded.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { devtoCreateArticle } from "./platforms/devto.js";
import { blueskyPost } from "./platforms/bluesky.js";
import { mastodonPost } from "./platforms/mastodon.js";
import { redditSubmit } from "./platforms/reddit.js";

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "social-media-server",
  version: "0.1.0",
});

// ---------------------------------------------------------------------------
// dev.to — devto_create_article
// ---------------------------------------------------------------------------

server.tool(
  "devto_create_article",
  "Create an article on dev.to. Defaults to published=false (draft). Set published=true only when explicitly instructed.",
  {
    title: z.string().min(1).describe("Article title"),
    body_markdown: z.string().min(1).describe("Article body in Markdown"),
    tags: z.array(z.string()).optional().describe("Up to 4 tags (dev.to limit)"),
    published: z.boolean().optional().default(false).describe("Whether to publish immediately. Defaults to false (draft)."),
  },
  async ({ title, body_markdown, tags, published }) => {
    const result = await devtoCreateArticle({ title, body_markdown, tags, published });

    if (!result.success) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: result.error }),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result.data),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Bluesky — bluesky_post
// ---------------------------------------------------------------------------

server.tool(
  "bluesky_post",
  "Post a text update to Bluesky (AT Protocol). Maximum 300 characters; longer text is truncated.",
  {
    text: z.string().min(1).max(300).describe("Post text (max 300 characters)"),
  },
  async ({ text }) => {
    const result = await blueskyPost({ text });

    if (!result.success) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: result.error }),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result.data),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Mastodon — mastodon_post
// ---------------------------------------------------------------------------

server.tool(
  "mastodon_post",
  "Post a status to Mastodon. Visibility defaults to 'public'.",
  {
    status: z.string().min(1).describe("Status text"),
    visibility: z
      .enum(["public", "unlisted", "private", "direct"])
      .optional()
      .default("public")
      .describe("Post visibility"),
  },
  async ({ status, visibility }) => {
    const result = await mastodonPost({ status, visibility });

    if (!result.success) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: result.error }),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result.data),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Reddit — reddit_submit (human-review guardrail)
// ---------------------------------------------------------------------------

server.tool(
  "reddit_submit",
  [
    "Submit a self-post (text post) to a subreddit.",
    "⚠️ HUMAN REVIEW REQUIRED: Without confirm=true this tool returns a preview only and does NOT post.",
    "Always show the preview to the user and wait for explicit approval before re-calling with confirm=true.",
  ].join(" "),
  {
    subreddit: z.string().min(1).describe("Target subreddit name (without r/ prefix)"),
    title: z.string().min(1).describe("Post title"),
    text: z.string().min(1).describe("Post body (Markdown)"),
    confirm: z
      .boolean()
      .optional()
      .default(false)
      .describe("Set to true ONLY after human has reviewed the preview and approved submission"),
  },
  async ({ subreddit, title, text, confirm }) => {
    const result = await redditSubmit({ subreddit, title, text, confirm });

    if (!result.success) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: result.error }),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result.data),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
