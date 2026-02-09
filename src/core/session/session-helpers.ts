import { closeSync, openSync, readSync, statSync } from "fs";
import {
  DEFAULT_THINKING_TOKENS,
  THINKING_DEEP_KEYWORDS,
  THINKING_KEYWORDS,
} from "../../config";
import type {
  SessionData,
  SteeringMessage,
  TokenUsage,
  UsageSnapshot,
} from "../../types";
import { fetchClaudeUsage } from "../../usage";

export type ContextWindowUsage = NonNullable<SessionData["contextWindowUsage"]>;

export interface ClaudeCodeContextWindow {
  current_usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  context_window_size?: number;
}

export function getThinkingLevel(message: string): number {
  const msgLower = message.toLowerCase();
  if (THINKING_DEEP_KEYWORDS.some((k) => msgLower.includes(k))) return 50000;
  if (THINKING_KEYWORDS.some((k) => msgLower.includes(k))) return 10000;
  return DEFAULT_THINKING_TOKENS;
}

export function mergeLatestUsage(
  prev: TokenUsage | null,
  update: Partial<TokenUsage>
): TokenUsage {
  function pick(updateVal: number | undefined, prevVal: number): number {
    return typeof updateVal === "number" && updateVal > 0 ? updateVal : prevVal;
  }

  const base = prev ?? {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };

  return {
    input_tokens: pick(update.input_tokens, base.input_tokens),
    output_tokens:
      typeof update.output_tokens === "number"
        ? update.output_tokens
        : base.output_tokens,
    cache_read_input_tokens: pick(
      update.cache_read_input_tokens,
      base.cache_read_input_tokens ?? 0
    ),
    cache_creation_input_tokens: pick(
      update.cache_creation_input_tokens,
      base.cache_creation_input_tokens ?? 0
    ),
  };
}

export async function captureUsageSnapshot(): Promise<UsageSnapshot | null> {
  try {
    const usage = await fetchClaudeUsage(0); // bypass cache
    if (!usage) return null;
    return {
      fiveHour: usage.five_hour ? Math.round(usage.five_hour.utilization * 10) / 10 : 0,
      sevenDay: usage.seven_day ? Math.round(usage.seven_day.utilization) : 0,
    };
  } catch {
    return null;
  }
}

export function isClaudeCodeContextWindow(
  value: unknown
): value is ClaudeCodeContextWindow {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const currentUsage = record.current_usage;
  if (
    currentUsage !== undefined &&
    currentUsage !== null &&
    typeof currentUsage !== "object"
  ) {
    return false;
  }
  const windowSize = record.context_window_size;
  if (windowSize !== undefined && typeof windowSize !== "number") return false;
  return true;
}

export function getClaudeProjectsDir(): string | null {
  return process.env.HOME ? `${process.env.HOME}/.claude/projects` : null;
}

export function getClaudeProjectSlug(workingDir: string): string {
  return workingDir.replace(/[^A-Za-z0-9]/g, "-");
}

export function readFileTail(path: string, maxBytes: number): string | null {
  try {
    const stats = statSync(path);
    const size = stats.size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;

    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, start);
      if (read <= 0) return null;
      return buffer.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function extractMainAssistantContextUsageFromTranscriptLine(
  line: string,
  sessionId: string,
  minTimestampMs: number
): ContextWindowUsage | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;

    if (record.type !== "assistant") return null;
    if (record.sessionId !== sessionId) return null;
    if ("isSidechain" in record && record.isSidechain !== false) return null;

    const timestampStr = typeof record.timestamp === "string" ? record.timestamp : null;
    if (timestampStr) {
      const ts = Date.parse(timestampStr);
      if (!Number.isNaN(ts) && ts < minTimestampMs) return null;
    }

    const msg = record.message;
    if (!msg || typeof msg !== "object") return null;
    const usage = (msg as Record<string, unknown>).usage;
    if (!usage || typeof usage !== "object") return null;

    const usageRecord = usage as Record<string, unknown>;
    const input_tokens =
      typeof usageRecord.input_tokens === "number" ? usageRecord.input_tokens : 0;
    const cache_creation_input_tokens =
      typeof usageRecord.cache_creation_input_tokens === "number"
        ? usageRecord.cache_creation_input_tokens
        : 0;
    const cache_read_input_tokens =
      typeof usageRecord.cache_read_input_tokens === "number"
        ? usageRecord.cache_read_input_tokens
        : 0;

    const used = input_tokens + cache_creation_input_tokens + cache_read_input_tokens;
    if (used <= 0) return null;

    return {
      input_tokens,
      cache_creation_input_tokens,
      cache_read_input_tokens,
    };
  } catch {
    return null;
  }
}

export function formatSteeringMessages(messages: SteeringMessage[]): string {
  return messages
    .map((msg) => {
      const ts = new Date(msg.timestamp).toLocaleTimeString("en-US", {
        hour12: false,
      });
      const tool = msg.receivedDuringTool ? ` (during ${msg.receivedDuringTool})` : "";
      return `[${ts}${tool}] ${msg.content}`;
    })
    .join("\n---\n");
}
