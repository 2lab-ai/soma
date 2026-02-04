#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";

const DATA_DIR = join(dirname(dirname(dirname(import.meta.path))), "data", "chats");

interface ChatRecord {
  id: string;
  sessionId: string;
  claudeSessionId: string;
  model: string;
  timestamp: string;
  speaker: "user" | "assistant";
  content: string;
  tokenUsage?: { input: number; output: number };
}

async function getRecentChats(limit: number = 20): Promise<ChatRecord[]> {
  if (!existsSync(DATA_DIR)) return [];

  const files = await readdir(DATA_DIR);
  const ndjsonFiles = files.filter(f => f.endsWith(".ndjson")).sort().reverse();

  const records: ChatRecord[] = [];

  for (const file of ndjsonFiles) {
    if (records.length >= limit) break;

    const content = await readFile(join(DATA_DIR, file), "utf-8");
    const lines = content.split("\n").filter(l => l.trim()).reverse();

    for (const line of lines) {
      if (records.length >= limit) break;
      try {
        records.push(JSON.parse(line));
      } catch {}
    }
  }

  return records.slice(0, limit);
}

async function searchChats(query: string, limit: number = 50): Promise<ChatRecord[]> {
  if (!existsSync(DATA_DIR)) return [];

  const files = await readdir(DATA_DIR);
  const ndjsonFiles = files.filter(f => f.endsWith(".ndjson")).sort().reverse();

  const records: ChatRecord[] = [];
  const lowerQuery = query.toLowerCase();

  for (const file of ndjsonFiles) {
    if (records.length >= limit) break;

    const content = await readFile(join(DATA_DIR, file), "utf-8");
    const lines = content.split("\n").filter(l => l.trim());

    for (const line of lines) {
      if (records.length >= limit) break;
      try {
        const record: ChatRecord = JSON.parse(line);
        if (record.content.toLowerCase().includes(lowerQuery)) {
          records.push(record);
        }
      } catch {}
    }
  }

  return records;
}

async function getChatsByDate(date: string): Promise<ChatRecord[]> {
  const filePath = join(DATA_DIR, `${date}.ndjson`);
  if (!existsSync(filePath)) return [];

  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n").filter(l => l.trim());

  return lines.map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function formatChatRecord(r: ChatRecord): string {
  const time = new Date(r.timestamp).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  const speaker = r.speaker === "user" ? "👤 User" : "🤖 Assistant";
  const preview = r.content.length > 200 ? r.content.slice(0, 200) + "..." : r.content;
  return `[${time}] ${speaker}:\n${preview}`;
}

const server = new Server(
  { name: "chat-history", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_recent_chats",
      description: "Get the most recent chat messages from the conversation history. Returns messages in reverse chronological order.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of messages to retrieve (default: 20, max: 100)",
            default: 20
          }
        }
      }
    },
    {
      name: "search_chats",
      description: "Search chat history for messages containing a specific keyword or phrase.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query (case-insensitive)"
          },
          limit: {
            type: "number",
            description: "Maximum results to return (default: 50)",
            default: 50
          }
        },
        required: ["query"]
      }
    },
    {
      name: "get_chats_by_date",
      description: "Get all chat messages from a specific date.",
      inputSchema: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Date in YYYY-MM-DD format"
          }
        },
        required: ["date"]
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "get_recent_chats": {
        const limit = Math.min((args as any)?.limit || 20, 100);
        const records = await getRecentChats(limit);
        const formatted = records.map(formatChatRecord).join("\n\n---\n\n");
        return {
          content: [{ type: "text", text: formatted || "No chat history found." }]
        };
      }

      case "search_chats": {
        const query = (args as any)?.query;
        if (!query) throw new Error("query is required");
        const limit = Math.min((args as any)?.limit || 50, 100);
        const records = await searchChats(query, limit);
        const formatted = records.map(formatChatRecord).join("\n\n---\n\n");
        return {
          content: [{ type: "text", text: formatted || `No messages found containing "${query}".` }]
        };
      }

      case "get_chats_by_date": {
        const date = (args as any)?.date;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          throw new Error("date must be in YYYY-MM-DD format");
        }
        const records = await getChatsByDate(date);
        const formatted = records.map(formatChatRecord).join("\n\n---\n\n");
        return {
          content: [{ type: "text", text: formatted || `No chat history found for ${date}.` }]
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
      isError: true
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
