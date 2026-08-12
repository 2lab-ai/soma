import type { Provider } from "./provider";

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
