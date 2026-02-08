export interface ChatRecord {
  id: string;
  sessionId: string;
  claudeSessionId: string;
  model: string;
  timestamp: string;
  speaker: "user" | "assistant" | "tool" | "system";
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  thinkingSummary?: string;
  tokenUsage?: {
    input: number;
    output: number;
  };
}

export interface SessionReference {
  sessionId: string;
  claudeSessionId: string;
  transcriptPath: string;
  startTime: string;
  endTime?: string;
  messageCount: number;
}

export interface Summary {
  id: string;
  periodStart: string;
  periodEnd: string;
  granularity: "hourly" | "daily" | "weekly" | "monthly";
  model: string;
  content: string;
  chatCount: number;
}

export type SummaryGranularity = Summary["granularity"];

export interface ChatSearchOptions {
  from: Date;
  to: Date;
  query?: string;
  sessionId?: string;
  storagePartitionKey?: string;
  speaker?: ChatRecord["speaker"];
  limit?: number;
  offset?: number;
}

export interface SummarySearchOptions {
  granularity: SummaryGranularity;
  from: Date;
  to: Date;
  limit?: number;
}

export interface IChatStorage {
  saveChat(record: ChatRecord): Promise<void>;
  saveBatch(records: ChatRecord[]): Promise<void>;
  search(options: ChatSearchOptions): Promise<ChatRecord[]>;
  getContextAround(
    timestamp: Date,
    before: number,
    after: number
  ): Promise<ChatRecord[]>;
  saveSessionReference(ref: SessionReference): Promise<void>;
  getSessionReference(sessionId: string): Promise<SessionReference | null>;
}

export interface ISummaryStorage {
  saveSummary(summary: Summary): Promise<void>;
  getSummaries(options: SummarySearchOptions): Promise<Summary[]>;
  getLatest(granularity: SummaryGranularity, count: number): Promise<Summary[]>;
  getSummary(granularity: SummaryGranularity, date: Date): Promise<Summary | null>;
}

export interface ChatHistoryConfig {
  dataDir: string;
  retentionDays: {
    chats: number | null;
    summaries: number | null;
  };
  summaryModel: string;
  enabled: boolean;
}

export const DEFAULT_CHAT_HISTORY_CONFIG: ChatHistoryConfig = {
  dataDir: "data",
  retentionDays: {
    chats: null,
    summaries: null,
  },
  summaryModel: "claude-haiku-4-20250514",
  enabled: true,
};
