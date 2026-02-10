import type { Provider } from "./provider";

// Query metadata for response footer
export interface UsageSnapshot {
  fiveHour: number;
  sevenDay: number;
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
