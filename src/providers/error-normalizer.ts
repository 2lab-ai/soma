import type { ProviderBoundaryError, ProviderBoundaryErrorCode } from "./types.models";

const RATE_LIMIT_PATTERNS = [
  "429",
  "rate_limit",
  "rate limit",
  "too many requests",
  "overloaded",
  "capacity",
  "quota",
  "usage limit",
];

const AUTH_PATTERNS = ["401", "403", "unauthorized", "forbidden", "invalid api key"];
const NETWORK_PATTERNS = [
  "network",
  "econnrefused",
  "etimedout",
  "socket hang up",
  "fetch failed",
];
const TOOL_PATTERNS = ["tool", "mcp", "hook"];
const ABORT_PATTERNS = ["abort", "aborted", "cancelled", "canceled"];
const CONTEXT_LIMIT_PATTERNS = ["context limit", "context_length", "too large"];
const INVALID_REQUEST_PATTERNS = ["invalid request", "bad request", "400"];

export class NormalizedProviderError extends Error implements ProviderBoundaryError {
  readonly boundary = "provider" as const;
  readonly code: ProviderBoundaryErrorCode;
  readonly providerId: string;
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(
    providerId: string,
    code: ProviderBoundaryErrorCode,
    message: string,
    retryable: boolean,
    statusCode?: number
  ) {
    super(message);
    this.name = "NormalizedProviderError";
    this.providerId = providerId;
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

function containsAny(lowerMessage: string, patterns: string[]): boolean {
  return patterns.some((pattern) => lowerMessage.includes(pattern));
}

function inferStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const statusCode =
    (error as { statusCode?: unknown }).statusCode ??
    (error as { status?: unknown }).status;
  return typeof statusCode === "number" ? statusCode : undefined;
}

function inferErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function inferCodeFromMessage(message: string): ProviderBoundaryErrorCode {
  const lower = message.toLowerCase();
  if (containsAny(lower, RATE_LIMIT_PATTERNS)) return "RATE_LIMIT";
  if (containsAny(lower, AUTH_PATTERNS)) return "AUTH";
  if (containsAny(lower, NETWORK_PATTERNS)) return "NETWORK";
  if (containsAny(lower, TOOL_PATTERNS)) return "TOOL";
  if (containsAny(lower, ABORT_PATTERNS)) return "ABORT";
  if (containsAny(lower, CONTEXT_LIMIT_PATTERNS)) return "CONTEXT_LIMIT";
  if (containsAny(lower, INVALID_REQUEST_PATTERNS)) return "INVALID_REQUEST";
  return "INTERNAL";
}

function isRetryable(code: ProviderBoundaryErrorCode): boolean {
  return code === "RATE_LIMIT" || code === "NETWORK";
}

export function normalizeProviderError(
  providerId: string,
  error: unknown
): NormalizedProviderError {
  if (error instanceof NormalizedProviderError) {
    return error;
  }

  const message = inferErrorMessage(error);
  const statusCode = inferStatusCode(error);
  const code = inferCodeFromMessage(message);
  return new NormalizedProviderError(
    providerId,
    code,
    message,
    isRetryable(code),
    statusCode
  );
}
