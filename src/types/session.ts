// Session persistence data
export interface SessionData {
  session_id: string;
  saved_at: string;
  working_dir: string;
  // Best-effort context window snapshot (matches Claude dashboard "current_usage" semantics)
  contextWindowUsage?: {
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  } | null;
  contextWindowSize?: number;
  // Token tracking (for context window usage)
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalQueries?: number;
  sessionStartTime?: string;
}

// Token usage from Claude
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// Steering message structure (real-time user messages during Claude execution)
export interface SteeringMessage {
  content: string;
  messageId: number;
  timestamp: number;
  receivedDuringTool?: string;
}

// Result from session.kill() - includes lost messages for recovery UI
export interface KillResult {
  count: number;
  messages: SteeringMessage[];
}

// Pending recovery state for inline button flow
export interface PendingRecovery {
  messages: SteeringMessage[];
  promptedAt: number;
  state: "awaiting" | "resolved";
  chatId: number;
  messageId?: number; // Telegram message ID with buttons
}

export const PENDING_RECOVERY_TIMEOUT_MS = 60_000; // 60 seconds

// Factory function for creating validated SteeringMessage instances
export function createSteeringMessage(
  content: string,
  messageId: number,
  receivedDuringTool?: string
): SteeringMessage {
  // Validate content is not empty
  const trimmedContent = content.trim();
  if (!trimmedContent) {
    throw new Error("Steering message content cannot be empty");
  }

  // Validate messageId is a positive integer
  if (!Number.isInteger(messageId) || messageId <= 0) {
    throw new Error(`Message ID must be a positive integer, got: ${messageId}`);
  }

  return {
    content: trimmedContent,
    messageId,
    timestamp: Date.now(),
    receivedDuringTool: receivedDuringTool || undefined,
  };
}
