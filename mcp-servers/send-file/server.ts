#!/usr/bin/env bun
/**
 * Send File MCP Server
 *
 * Allows Claude to send files/documents to the current Telegram chat.
 * Uses Telegram Bot HTTP API directly (since MCP servers run as separate processes).
 *
 * Environment variables (passed via mcp-config.ts):
 *   TELEGRAM_BOT_TOKEN - Bot token for API calls
 *   TELEGRAM_CHAT_ID   - Target chat ID to send files to
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile, stat } from "fs/promises";
import { basename, resolve } from "path";
import { convertMarkdownToHtml } from "../../src/formatting";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Security: only allow sending files from these directories
const ALLOWED_DIRS = [
  "/home/zhugehyuk/2lab.ai",
  "/home/zhugehyuk/.claude",
  "/tmp",
];

function isPathAllowed(filePath: string): boolean {
  const resolved = resolve(filePath);
  return ALLOWED_DIRS.some((dir) => resolved.startsWith(dir));
}

async function sendDocument(
  chatId: string,
  filePath: string,
  caption?: string
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  const resolved = resolve(filePath);

  // Security check
  if (!isPathAllowed(resolved)) {
    return {
      ok: false,
      error: `Path not allowed. Must be under: ${ALLOWED_DIRS.join(", ")}`,
    };
  }

  // Check file exists
  try {
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) {
      return { ok: false, error: `Not a file: ${resolved}` };
    }
    // Telegram limit: 50MB for bots
    if (fileStat.size > 50 * 1024 * 1024) {
      return { ok: false, error: `File too large (${fileStat.size} bytes). Telegram limit: 50MB` };
    }
  } catch {
    return { ok: false, error: `File not found: ${resolved}` };
  }

  // Read file and send via multipart/form-data
  const fileData = await readFile(resolved);
  const fileName = basename(resolved);

  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("document", new Blob([fileData]), fileName);
  if (caption) {
    formData.append("caption", caption);
  }

  const response = await fetch(`${TELEGRAM_API}/sendDocument`, {
    method: "POST",
    body: formData,
  });

  const result = (await response.json()) as {
    ok: boolean;
    result?: { message_id: number };
    description?: string;
  };

  if (!result.ok) {
    return { ok: false, error: result.description || "Telegram API error" };
  }

  return { ok: true, messageId: result.result?.message_id };
}

async function sendPhoto(
  chatId: string,
  filePath: string,
  caption?: string
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  const resolved = resolve(filePath);

  if (!isPathAllowed(resolved)) {
    return {
      ok: false,
      error: `Path not allowed. Must be under: ${ALLOWED_DIRS.join(", ")}`,
    };
  }

  try {
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) {
      return { ok: false, error: `Not a file: ${resolved}` };
    }
    // Telegram photo limit: 10MB
    if (fileStat.size > 10 * 1024 * 1024) {
      return { ok: false, error: `Photo too large (${fileStat.size} bytes). Telegram limit: 10MB` };
    }
  } catch {
    return { ok: false, error: `File not found: ${resolved}` };
  }

  const fileData = await readFile(resolved);
  const fileName = basename(resolved);

  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("photo", new Blob([fileData]), fileName);
  if (caption) {
    formData.append("caption", caption);
  }

  const response = await fetch(`${TELEGRAM_API}/sendPhoto`, {
    method: "POST",
    body: formData,
  });

  const result = (await response.json()) as {
    ok: boolean;
    result?: { message_id: number };
    description?: string;
  };

  if (!result.ok) {
    return { ok: false, error: result.description || "Telegram API error" };
  }

  return { ok: true, messageId: result.result?.message_id };
}

async function sendMessage(
  chatId: string,
  text: string
): Promise<{ ok: boolean; messageId?: number; mode?: string; error?: string }> {
  const trimmed = text?.trim();
  if (!trimmed) {
    return { ok: false, error: "text is empty" };
  }
  // Telegram hard-caps a single message at 4096 chars.
  const body = trimmed.slice(0, 4096);

  // Try rich HTML first (markdown -> balanced Telegram HTML). If Telegram
  // rejects the entities for any reason, fall back to plain text so delivery
  // still succeeds — the caller can then trust a true/false result.
  const html = convertMarkdownToHtml(body);

  const attempt = async (
    payload: Record<string, unknown>
  ): Promise<{ ok: boolean; messageId?: number; error?: string }> => {
    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...payload }),
    });
    const result = (await response.json()) as {
      ok: boolean;
      result?: { message_id: number };
      description?: string;
    };
    if (!result.ok) {
      return { ok: false, error: result.description || "Telegram API error" };
    }
    return { ok: true, messageId: result.result?.message_id };
  };

  const htmlResult = await attempt({ text: html, parse_mode: "HTML" });
  if (htmlResult.ok) {
    return { ok: true, messageId: htmlResult.messageId, mode: "html" };
  }

  const plainResult = await attempt({ text: body });
  if (plainResult.ok) {
    return { ok: true, messageId: plainResult.messageId, mode: "plain" };
  }

  return { ok: false, error: plainResult.error || htmlResult.error };
}

// --- MCP Server Setup ---

const server = new Server(
  { name: "send-file", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "send_document",
      description:
        "Send a file/document to the user via Telegram. " +
        "Use this to share files, logs, reports, code files, etc. " +
        "The file must exist on the server filesystem. " +
        "Allowed paths: /home/zhugehyuk/2lab.ai/*, ~/.claude/*, /tmp/*. " +
        "Max file size: 50MB.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              "Absolute path to the file to send. Must be under allowed directories.",
          },
          caption: {
            type: "string",
            description:
              "Optional caption/description for the file (max 1024 chars).",
          },
        },
        required: ["filePath"],
      },
    },
    {
      name: "send_photo",
      description:
        "Send a photo/image to the user via Telegram. " +
        "Use this for screenshots, charts, diagrams, etc. " +
        "Supported formats: JPG, PNG, GIF, BMP, WEBP. " +
        "Max file size: 10MB.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              "Absolute path to the image file to send.",
          },
          caption: {
            type: "string",
            description:
              "Optional caption for the photo (max 1024 chars).",
          },
        },
        required: ["filePath"],
      },
    },
    {
      name: "send_message",
      description:
        "Send a TEXT message to the user via Telegram and get a verified " +
        "delivery result. Use this when you must KNOW whether the message " +
        "actually reached the user before recording it as sent (e.g. cron " +
        "jobs that log delivery). Markdown is rendered to Telegram HTML; if " +
        "Telegram rejects the formatting it automatically retries as plain " +
        "text. Returns JSON {ok, messageId, mode}. Only treat the message as " +
        "delivered when ok is true. Max 4096 chars.",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description:
              "Message text (markdown supported). Max 4096 chars; longer text is truncated.",
          },
        },
        required: ["text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Validate env
  if (!BOT_TOKEN) {
    return {
      content: [
        {
          type: "text",
          text: "Error: TELEGRAM_BOT_TOKEN not configured for send-file MCP server.",
        },
      ],
      isError: true,
    };
  }
  if (!CHAT_ID) {
    return {
      content: [
        {
          type: "text",
          text: "Error: TELEGRAM_CHAT_ID not configured for send-file MCP server.",
        },
      ],
      isError: true,
    };
  }

  try {
    switch (name) {
      case "send_document": {
        const filePath = (args as { filePath: string; caption?: string }).filePath;
        const caption = (args as { filePath: string; caption?: string }).caption;

        if (!filePath) {
          return {
            content: [{ type: "text", text: "Error: filePath is required" }],
            isError: true,
          };
        }

        const result = await sendDocument(CHAT_ID, filePath, caption);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: !result.ok,
        };
      }

      case "send_photo": {
        const filePath = (args as { filePath: string; caption?: string }).filePath;
        const caption = (args as { filePath: string; caption?: string }).caption;

        if (!filePath) {
          return {
            content: [{ type: "text", text: "Error: filePath is required" }],
            isError: true,
          };
        }

        const result = await sendPhoto(CHAT_ID, filePath, caption);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: !result.ok,
        };
      }

      case "send_message": {
        const text = (args as { text?: string }).text;

        if (!text) {
          return {
            content: [{ type: "text", text: "Error: text is required" }],
            isError: true,
          };
        }

        const result = await sendMessage(CHAT_ID, text);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: !result.ok,
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Error: Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        { type: "text", text: `Error: ${(error as Error).message}` },
      ],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
