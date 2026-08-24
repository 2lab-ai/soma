import type { ConfigContext } from "../config/model";
import type { Provider } from "./provider";

/**
 * Who and where a query runs for — passed to every `sendMessageStreaming`.
 *
 * `userId` is **required**, deliberately. It used to be an optional 5th
 * positional argument, and every media handler forgot it once (issue #79): in
 * a group chat the tool-permission prompt then silently fell back to
 * chat-level authorization, so any authorized member could approve another
 * member's tool call. A required property turns that omission into a compile
 * error; `userId: undefined` remains expressible, but only on purpose.
 */
export interface QueryContext {
  /** Telegram chat the query belongs to. Undefined = no chat routed. */
  chatId: number | undefined;
  /** Telegram user who caused this query — the only valid approver. */
  userId: number | undefined;
  /** Model-selection context. Defaults to "general". */
  modelContext?: ConfigContext;
}

// Query metadata for response footer
export interface UsageSnapshot {
  fiveHour: number;
  sevenDay: number;
  /** Which backend produced the numbers. Absent = legacy oauth snapshot. */
  source?: "oauth" | "llmux";
  /** llmux only: account whose 5h/7d windows are shown. */
  account?: string;
  /** llmux only: claude-group accounts currently usable (status active|ok). */
  poolOk?: number;
  /** llmux only: total claude-group accounts in the pool. */
  poolTotal?: number;
}

export interface QueryMetadata {
  usageBefore: UsageSnapshot | null;
  usageAfter: UsageSnapshot | null;
  toolDurations: Record<string, { count: number; totalMs: number }>;
  queryDurationMs: number;
  contextUsagePercent?: number;
  contextUsagePercentBefore?: number;
  currentProvider?: Provider;
  resetTimeMs?: number;
  modelDisplayName?: string;
}

// Status callback for streaming updates
export type StatusCallback = (
  type:
    | "thinking"
    | "tool"
    | "text"
    | "segment_end"
    | "done"
    | "steering_pending"
    | "system",
  content: string,
  segmentId?: number,
  metadata?: QueryMetadata & { steeringCount?: number }
) => Promise<void>;
