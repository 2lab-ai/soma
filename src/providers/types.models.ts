import type { SessionIdentity } from "../routing/session-key";

export type QueryPermissionMode = "default" | "safe" | "bypass";

export interface ProviderBoundaryCapabilities {
  supportsResume: boolean;
  supportsMidStreamInjection: boolean;
  supportsToolStreaming: boolean;
}

export interface ProviderToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Readonly<Record<string, unknown>>;
}

export interface ProviderQueryInput {
  queryId: string;
  identity: SessionIdentity;
  prompt: string;
  modelId?: string;
  workingDirectory?: string;
  resumeSessionId?: string;
  maxThinkingTokens?: number;
  mcpServers?: Readonly<Record<string, unknown>>;
  additionalDirectories?: ReadonlyArray<string>;
  systemPrompt?: string;
  tools?: ReadonlyArray<ProviderToolDefinition>;
  metadata?: Readonly<Record<string, unknown>>;
  permissionMode?: QueryPermissionMode;
}

export interface ProviderQueryHandle {
  queryId: string;
  providerSessionId?: string;
}

export interface ProviderResumeInput {
  identity: SessionIdentity;
  providerSessionId: string;
}

export interface ProviderResumeResult {
  providerSessionId: string;
  resumed: boolean;
}

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

interface ProviderEventBase {
  providerId: string;
  queryId: string;
  timestamp: number;
}

export interface ProviderTextEvent extends ProviderEventBase {
  type: "text";
  delta: string;
}

export interface ProviderToolEvent extends ProviderEventBase {
  type: "tool";
  toolName: string;
  phase: "start" | "end";
  payload?: unknown;
}

export interface ProviderUsageEvent extends ProviderEventBase {
  type: "usage";
  usage: NormalizedUsage;
}

export interface ProviderSessionEvent extends ProviderEventBase {
  type: "session";
  providerSessionId: string;
  resumed: boolean;
}

export interface ProviderContextEvent extends ProviderEventBase {
  type: "context";
  usedTokens: number;
  maxTokens: number;
}

export interface ProviderRateLimitEvent extends ProviderEventBase {
  type: "rate_limit";
  retryAfterMs?: number;
  resetAtMs?: number;
  statusCode?: number;
}

export interface ProviderDoneEvent extends ProviderEventBase {
  type: "done";
  reason: "completed" | "aborted" | "failed";
  errorMessage?: string;
}

export type ProviderEvent =
  | ProviderTextEvent
  | ProviderToolEvent
  | ProviderUsageEvent
  | ProviderSessionEvent
  | ProviderContextEvent
  | ProviderRateLimitEvent
  | ProviderDoneEvent;

export type ProviderEventHandler = (
  event: ProviderEvent
) => void | Promise<void>;

export type ProviderBoundaryErrorCode =
  | "RATE_LIMIT"
  | "AUTH"
  | "NETWORK"
  | "TOOL"
  | "ABORT"
  | "CONTEXT_LIMIT"
  | "INVALID_REQUEST"
  | "INTERNAL";

export interface ProviderBoundaryError extends Error {
  readonly boundary: "provider";
  readonly code: ProviderBoundaryErrorCode;
  readonly providerId: string;
  readonly retryable: boolean;
  readonly statusCode?: number;
}

export interface ProviderBoundary {
  readonly providerId: string;
  readonly capabilities: ProviderBoundaryCapabilities;
  startQuery(input: ProviderQueryInput): Promise<ProviderQueryHandle>;
  streamEvents(
    handle: ProviderQueryHandle,
    onEvent: ProviderEventHandler
  ): Promise<void>;
  abortQuery(handle: ProviderQueryHandle, reason?: string): Promise<void>;
  resumeSession(input: ProviderResumeInput): Promise<ProviderResumeResult>;
}
