#!/usr/bin/env bun
/**
 * chat-search CLI - Search conversation history for Claude access
 *
 * Usage:
 *   bun scripts/chat-search.ts recent [--hours N | --days N] [--limit N]
 *   bun scripts/chat-search.ts search <keyword> [--days N] [--limit N]
 *   bun scripts/chat-search.ts today [--limit N]
 *   bun scripts/chat-search.ts summary [--days N]
 */

import { FileChatStorage } from "../src/storage/chat-storage";
import { ChatSearchService } from "../src/services/chat-search-service";
import type { ChatRecord } from "../src/types/chat-history";

const DATA_DIR = "./data";
const storage = new FileChatStorage(DATA_DIR);
const search = new ChatSearchService(storage);

function formatMessage(record: ChatRecord): string {
  const time = new Date(record.timestamp).toLocaleString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const speaker = record.speaker.toUpperCase().padEnd(9);
  const content = record.content.length > 200
    ? record.content.slice(0, 200) + "..."
    : record.content;
  return `[${time}] ${speaker} ${content}`;
}

function formatResults(records: ChatRecord[], title: string): string {
  if (records.length === 0) {
    return `${title}\n\nNo messages found.`;
  }

  const lines = records
    .filter(r => r.speaker !== "tool")
    .map(formatMessage);

  return `${title} (${records.length} messages)\n${"=".repeat(50)}\n\n${lines.join("\n\n")}`;
}

async function cmdRecent(args: string[]): Promise<void> {
  let hours: number | undefined;
  let days: number | undefined;
  let limit = 20;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--hours" && args[i + 1]) {
      hours = parseInt(args[i + 1]!);
      i++;
    } else if (args[i] === "--days" && args[i + 1]) {
      days = parseInt(args[i + 1]!);
      i++;
    } else if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[i + 1]!);
      i++;
    }
  }

  const records = await search.searchRecent({
    lastNHours: hours,
    lastNDays: days || (hours ? undefined : 1),
    limit,
  });

  const title = hours
    ? `Recent messages (last ${hours} hours)`
    : `Recent messages (last ${days || 1} day(s))`;
  console.log(formatResults(records, title));
}

async function cmdSearch(keyword: string, args: string[]): Promise<void> {
  let days = 7;
  let limit = 30;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1]) {
      days = parseInt(args[i + 1]!);
      i++;
    } else if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[i + 1]!);
      i++;
    }
  }

  const records = await search.searchByKeyword(keyword, { lastNDays: days, limit });
  console.log(formatResults(records, `Search: "${keyword}" (last ${days} days)`));
}

async function cmdToday(args: string[]): Promise<void> {
  let limit = 50;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[i + 1]!);
      i++;
    }
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const records = await search.searchByDateRange({
    from: today,
    to: tomorrow,
    limit,
  });

  console.log(formatResults(records, `Today's conversation`));
}

async function cmdSummary(args: string[]): Promise<void> {
  let days = 1;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1]) {
      days = parseInt(args[i + 1]!);
      i++;
    }
  }

  const from = new Date();
  from.setDate(from.getDate() - days);

  const records = await search.searchByDateRange({
    from,
    to: new Date(),
    limit: 500,
  });

  const userMsgs = records.filter(r => r.speaker === "user");
  const assistantMsgs = records.filter(r => r.speaker === "assistant");
  const toolMsgs = records.filter(r => r.speaker === "tool");

  const topics = new Set<string>();
  for (const r of userMsgs) {
    const words = r.content.toLowerCase().match(/\b\w{4,}\b/g) || [];
    words.slice(0, 5).forEach(w => topics.add(w));
  }

  console.log(`Conversation Summary (last ${days} day(s))\n${"=".repeat(50)}\n`);
  console.log(`📊 Stats:`);
  console.log(`   - User messages: ${userMsgs.length}`);
  console.log(`   - Assistant messages: ${assistantMsgs.length}`);
  console.log(`   - Tool calls: ${toolMsgs.length}`);
  console.log(`   - Total: ${records.length}`);
  console.log(`\n📝 Recent user messages:`);
  userMsgs.slice(-5).forEach(r => {
    const preview = r.content.slice(0, 100).replace(/\n/g, " ");
    console.log(`   - ${preview}${r.content.length > 100 ? "..." : ""}`);
  });
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(`
chat-search CLI - Search conversation history

Commands:
  recent [--hours N | --days N] [--limit N]  Get recent messages
  search <keyword> [--days N] [--limit N]    Search by keyword
  today [--limit N]                          Get today's conversation
  summary [--days N]                         Get conversation summary
  help                                       Show this help

Examples:
  bun scripts/chat-search.ts recent --hours 2
  bun scripts/chat-search.ts search "epic" --days 3
  bun scripts/chat-search.ts today
  bun scripts/chat-search.ts summary --days 7
`);
    return;
  }

  switch (cmd) {
    case "recent":
      await cmdRecent(args);
      break;
    case "search":
      if (!args[0]) {
        console.error("Error: keyword required. Usage: search <keyword>");
        process.exit(1);
      }
      await cmdSearch(args[0], args.slice(1));
      break;
    case "today":
      await cmdToday(args);
      break;
    case "summary":
      await cmdSummary(args);
      break;
    default:
      console.error(`Unknown command: ${cmd}. Use 'help' for usage.`);
      process.exit(1);
  }
}

main().catch(console.error);
