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
