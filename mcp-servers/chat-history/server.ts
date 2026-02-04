#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { dirname, join } from "path";

import { FileChatStorage } from "../../src/storage/chat-storage";
import { FileSummaryStorage } from "../../src/storage/summary-storage";
import { ChatSearchService } from "../../src/services/chat-search-service";
import type { ChatRecord, Summary, SummaryGranularity } from "../../src/types/chat-history";

const DATA_DIR = join(dirname(dirname(dirname(import.meta.path))), "data");
const chatStorage = new FileChatStorage(DATA_DIR);
const summaryStorage = new FileSummaryStorage(DATA_DIR);
const searchService = new ChatSearchService(chatStorage);

type ChatType = null | "chat" | "summary";

interface GetChatsResult {
  data: (ChatRecord | Summary)[];
  meta: {
    pointDate: string;
    lastN: number;
    afterN: number;
    type: ChatType;
    returned: number;
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
  };
}

interface GetChatsByDatesResult {
  data: (ChatRecord | Summary)[];
  meta: {
    from: string;
    to: string;
    returned: number;
    hasMore: boolean;
  };
}

interface GetChatsCountResult {
  count: number;
  from: string;
  to: string;
}

function selectGranularity(from: Date, to: Date): SummaryGranularity {
  const diffMs = to.getTime() - from.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  if (diffDays < 1) return "hourly";
  if (diffDays <= 7) return "daily";
  if (diffDays <= 60) return "weekly";
  return "monthly";
}

async function getChats(
  pointDate: string | null,
  lastN: number,
  afterN: number,
  type: ChatType
): Promise<GetChatsResult> {
  const point = pointDate ? new Date(pointDate) : new Date();
  const results: (ChatRecord | Summary)[] = [];

  if (type === "summary") {
    const beforeDate = new Date(point);
    beforeDate.setDate(beforeDate.getDate() - Math.max(lastN, 7));
    const afterDate = new Date(point);
    afterDate.setDate(afterDate.getDate() + Math.max(afterN, 7));

    const granularity = selectGranularity(beforeDate, afterDate);
    const summaries = await summaryStorage.getSummaries({
      granularity,
      from: beforeDate,
      to: afterDate,
      limit: lastN + afterN,
    });

    const before = summaries.filter(s => new Date(s.periodEnd) <= point).slice(0, lastN);
    const after = summaries.filter(s => new Date(s.periodStart) > point).slice(0, afterN);
    results.push(...before.reverse(), ...after);
  } else {
    const beforeMs = lastN * 60 * 60 * 1000;
    const afterMs = afterN * 60 * 60 * 1000;

    const fromDate = new Date(point.getTime() - beforeMs);
    const toDate = new Date(point.getTime() + afterMs);

    const chats = await searchService.searchByDateRange({
      from: fromDate,
      to: toDate,
      limit: lastN + afterN + 100,
    });

    const before = chats.filter(c => new Date(c.timestamp) <= point);
    const after = chats.filter(c => new Date(c.timestamp) > point);

    const selectedBefore = before.slice(-lastN);
    const selectedAfter = after.slice(0, afterN);

    results.push(...selectedBefore, ...selectedAfter);
  }

  return {
    data: results,
    meta: {
      pointDate: point.toISOString(),
      lastN,
      afterN,
      type,
      returned: results.length,
      hasMoreBefore: results.length > 0,
      hasMoreAfter: results.length > 0,
    },
  };
}

async function getChatsByDates(
  from: string,
  to: string,
  type: ChatType,
  limit: number
): Promise<GetChatsByDatesResult> {
  const fromDate = new Date(from);
  const toDate = new Date(to);

  let results: (ChatRecord | Summary)[] = [];

  if (type === "summary") {
    const granularity = selectGranularity(fromDate, toDate);
    results = await summaryStorage.getSummaries({
      granularity,
      from: fromDate,
      to: toDate,
      limit,
    });
  } else {
    results = await searchService.searchByDateRange({
      from: fromDate,
      to: toDate,
      limit,
    });
  }

  return {
    data: results,
    meta: {
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      returned: results.length,
      hasMore: results.length >= limit,
    },
  };
}

async function getChatsCountByDates(from: string, to: string): Promise<GetChatsCountResult> {
  const fromDate = new Date(from);
  const toDate = new Date(to);

  const chats = await searchService.searchByDateRange({
    from: fromDate,
    to: toDate,
    limit: 10000,
  });

  return {
    count: chats.length,
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
  };
}

const server = new Server(
  { name: "chat-history", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_chats",
      description: "Get chat messages or summaries around a specific point in time. Use lastN for messages before the point, afterN for messages after. Type: null (chats only), 'chat' (same as null), 'summary' (get summaries instead of individual messages).",
      inputSchema: {
        type: "object",
        properties: {
          pointDate: {
            type: "string",
            description: "ISO datetime as the reference point. If null/omitted, uses current time.",
          },
          lastN: {
            type: "number",
            description: "Number of messages/summaries before pointDate (default: 20)",
            default: 20,
          },
          afterN: {
            type: "number",
            description: "Number of messages/summaries after pointDate (default: 0)",
            default: 0,
          },
          type: {
            type: "string",
            enum: ["chat", "summary"],
            description: "Type of data to retrieve: 'chat' for messages (default), 'summary' for AI-generated summaries",
          },
        },
      },
    },
    {
      name: "get_chats_by_dates",
      description: "Get all chat messages or summaries within a datetime range.",
      inputSchema: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description: "Start datetime (ISO format)",
          },
          to: {
            type: "string",
            description: "End datetime (ISO format)",
          },
          type: {
            type: "string",
            enum: ["chat", "summary"],
            description: "Type of data: 'chat' (default) or 'summary'",
          },
          limit: {
            type: "number",
            description: "Maximum results (default: 100, max: 500)",
            default: 100,
          },
        },
        required: ["from", "to"],
      },
    },
    {
      name: "get_chats_count_by_dates",
      description: "Get the count of chat messages within a datetime range (useful to check before fetching large results).",
      inputSchema: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description: "Start datetime (ISO format)",
          },
          to: {
            type: "string",
            description: "End datetime (ISO format)",
          },
        },
        required: ["from", "to"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "get_chats": {
        const pointDate = (args as any)?.pointDate || null;
        const lastN = Math.min(Math.max((args as any)?.lastN || 20, 0), 500);
        const afterN = Math.min(Math.max((args as any)?.afterN || 0, 0), 500);
        const type: ChatType = (args as any)?.type === "summary" ? "summary" : null;

        const result = await getChats(pointDate, lastN, afterN, type);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "get_chats_by_dates": {
        const from = (args as any)?.from;
        const to = (args as any)?.to;
        if (!from || !to) throw new Error("from and to are required");

        const type: ChatType = (args as any)?.type === "summary" ? "summary" : null;
        const limit = Math.min(Math.max((args as any)?.limit || 100, 1), 500);

        const result = await getChatsByDates(from, to, type, limit);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "get_chats_count_by_dates": {
        const from = (args as any)?.from;
        const to = (args as any)?.to;
        if (!from || !to) throw new Error("from and to are required");

        const result = await getChatsCountByDates(from, to);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
