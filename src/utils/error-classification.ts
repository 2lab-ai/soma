/**
 * Error classification utilities for consistent error handling across handlers
 */

import type { Context } from "grammy";
import type { ClaudeSession } from "../core/session/session";
import type { ClaudeUsage } from "../types/provider";
import { Reactions } from "../constants/reactions";
import { sendSystemMessage } from "./system-message";
import { fetchClaudeUsage } from "../usage";

// Rate limit error detection patterns
const RATE_LIMIT_PATTERNS = [
  "429",
  "rate_limit",
  "rate limit",
  "too many requests",
  "overloaded",
  "capacity",
  "credit",
  "quota",
  "exceeded",
  "usage limit",
  "token limit",
];

export interface RateLimitInfo {
  isRateLimit: boolean;
  bucket: "opus" | "sonnet" | "unknown" | null;
  rawMessage: string;
}

export function isRateLimitError(error: unknown): RateLimitInfo {
  const msg = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  const lower = (msg + " " + name).toLowerCase();

  const matched = RATE_LIMIT_PATTERNS.some((p) => lower.includes(p));
  if (!matched) return { isRateLimit: false, bucket: null, rawMessage: msg };

  let bucket: RateLimitInfo["bucket"] = "unknown";
  if (lower.includes("opus")) bucket = "opus";
  else if (lower.includes("sonnet")) bucket = "sonnet";

  return { isRateLimit: true, bucket, rawMessage: msg };
}

function formatTimeRemaining(resetAt: string | null): string {
  if (!resetAt) return "알 수 없음";
  const diff = new Date(resetAt).getTime() - Date.now();
  if (diff <= 0) return "곧 리셋";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 24) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return `${d}일 ${rh}시간`;
  }
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
}

function formatUtilization(pct: number): string {
  return `${Math.round(pct * 100)}%`;
}

export async function formatRateLimitForUser(
  error: unknown,
  usage?: ClaudeUsage | null
): Promise<string> {
  const info = isRateLimitError(error);
  if (!usage) {
    try {
      usage = await fetchClaudeUsage(10);
    } catch {
      // ignore
    }
  }

  const lines: string[] = ["⚠️ **Rate Limit**"];

  if (usage) {
    lines.push("", "📊 Token Usage:");

    if (usage.five_hour) {
      const pct = formatUtilization(usage.five_hour.utilization);
      const reset = formatTimeRemaining(usage.five_hour.resets_at);
      lines.push(`  5h: ${pct} → 리셋 ${reset}`);
    }
    if (usage.seven_day) {
      const pct = formatUtilization(usage.seven_day.utilization);
      const reset = formatTimeRemaining(usage.seven_day.resets_at);
      lines.push(`  7d: ${pct} → 리셋 ${reset}`);
    }
    if (usage.seven_day_sonnet) {
      const pct = formatUtilization(usage.seven_day_sonnet.utilization);
      const reset = formatTimeRemaining(usage.seven_day_sonnet.resets_at);
      lines.push(`  7d Sonnet: ${pct} → 리셋 ${reset}`);
    }

    // Find soonest reset
    const resets = [usage.five_hour?.resets_at, usage.seven_day?.resets_at].filter(
      Boolean
    ) as string[];

    if (resets.length > 0) {
      const soonest = resets.map((r) => new Date(r).getTime()).sort((a, b) => a - b)[0];
      const diff = soonest! - Date.now();
      if (diff > 0) {
        lines.push(
          "",
          `⏰ 예상 복구: ${formatTimeRemaining(new Date(soonest!).toISOString())}`
        );
      }
    }
  } else {
    lines.push("", `❌ 사용량 조회 실패`);
    lines.push(`Raw: ${info.rawMessage.slice(0, 150)}`);
  }

  return lines.join("\n");
}

export function isSonnetAvailable(usage: ClaudeUsage | null): boolean {
  if (!usage?.seven_day_sonnet) return false;
  return usage.seven_day_sonnet.utilization < 0.8;
}

/**
 * Check if an error is an abort/cancellation error
 * Handles DOMException.AbortError, Node.js AbortError, and NormalizedProviderError with code ABORT
 */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // Check error name first (most reliable)
  if (error.name === "AbortError") return true;

  // Check NormalizedProviderError.code === "ABORT"
  // This catches "Claude Code process aborted by user" and similar SDK abort errors
  const anyError = error as unknown as { code?: string; boundary?: string };
  if (anyError.boundary === "provider" && anyError.code === "ABORT") return true;

  // Check for exact abort/cancel messages only (avoid partial matches)
  const msg = error.message.toLowerCase();
  return (
    msg === "aborted" ||
    msg === "cancelled" ||
    msg === "canceled" ||
    msg === "query cancelled" ||
    msg === "the operation was aborted" ||
    msg === "this operation was aborted"
  );
}

/**
 * Handle abort errors consistently across handlers
 * Checks if error is an abort, consumes interrupt flag, and optionally shows "Query stopped"
 * @returns true if error was handled as abort, false otherwise
 */
export async function handleAbortError(
  ctx: Context,
  error: unknown,
  session: ClaudeSession
): Promise<boolean> {
  if (!isAbortError(error)) return false;

  // Add interrupted reaction
  try {
    await ctx.react(Reactions.INTERRUPTED);
  } catch {
    // Ignore reaction errors
  }

  // Only show "Query stopped" if it was an explicit stop, not an interrupt
  const wasInterrupt = session.consumeInterruptFlag();
  if (!wasInterrupt) {
    await sendSystemMessage(ctx, "🛑 Query stopped.");
  }
  return true;
}

export interface ErrorDetails {
  message: string;
  name: string;
  stack?: string;
  cause?: unknown;
  stderr?: string;
  exitCode?: number;
  hint?: string;
  // SDK/Provider error fields
  statusCode?: number;
  errorCode?: string;
  providerId?: string;
  retryable?: boolean;
  requestId?: string;
  sdkErrors?: string[];
}

export function extractErrorDetails(error: unknown): ErrorDetails {
  if (!(error instanceof Error)) {
    return { message: String(error), name: "Unknown" };
  }

  const details: ErrorDetails = {
    message: error.message,
    name: error.name,
    stack: error.stack,
    cause: (error as Error & { cause?: unknown }).cause,
  };

  // Extract SDK/Provider error fields (NormalizedProviderError and similar)
  const anyError = error as unknown as Record<string, unknown>;
  if (typeof anyError.statusCode === "number") {
    details.statusCode = anyError.statusCode;
  } else if (typeof anyError.status === "number") {
    details.statusCode = anyError.status;
  }
  if (typeof anyError.code === "string") {
    // Skip Node.js system error codes (ENOENT, EACCES, etc.) — those are
    // handled by hint logic below. Only capture SDK/Provider error codes.
    const code = anyError.code;
    if (typeof code === "string" && !/^E[A-Z]{2,}/.test(code)) {
      details.errorCode = code;
    }
  }
  if (typeof anyError.providerId === "string") {
    details.providerId = anyError.providerId;
  }
  if (typeof anyError.retryable === "boolean") {
    details.retryable = anyError.retryable;
  }
  if (typeof anyError.request_id === "string") {
    details.requestId = anyError.request_id;
  }
  if (Array.isArray(anyError.errors)) {
    details.sdkErrors = anyError.errors
      .map((e: unknown) => {
        if (typeof e === "string") return e;
        if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
          return (e as { message: string }).message;
        }
        if (e !== null && e !== undefined) return String(e);
        return null;
      })
      .filter((e): e is string => e !== null);
  }

  // Extract exit code from message
  const exitMatch = error.message.match(/exited with code (\d+)/);
  if (exitMatch?.[1]) {
    details.exitCode = parseInt(exitMatch[1], 10);
  }

  // Extract stderr if available
  const stderrMatch = error.message.match(/stderr:\s*(.+?)(?:\n|$)/i);
  if (stderrMatch) {
    details.stderr = stderrMatch[1];
  }

  // Add hints based on error patterns
  if (details.exitCode === 1) {
    if (error.message.includes("session") || error.message.includes("resume")) {
      details.hint = "Session expired. Try /kill to reset.";
    } else if (error.message.includes("permission")) {
      details.hint = "Permission denied. Check file access.";
    } else if (error.message.includes("timeout")) {
      details.hint = "Operation timed out. Try again with smaller scope.";
    } else {
      details.hint = "Claude Code crashed. Session will auto-reconnect.";
    }
  } else if (error.message.includes("ENOENT")) {
    details.hint = "File not found. Check path.";
  } else if (error.message.includes("EACCES")) {
    details.hint = "Access denied. Check permissions.";
  }

  return details;
}

export function formatErrorForLog(error: unknown): string {
  const details = extractErrorDetails(error);
  const lines = [`[ERROR] ${details.name}: ${details.message}`];

  if (details.statusCode !== undefined) {
    lines.push(`HTTP status: ${details.statusCode}`);
  }
  if (details.errorCode) {
    lines.push(`Error code: ${details.errorCode}`);
  }
  if (details.providerId) {
    lines.push(`Provider: ${details.providerId}`);
  }
  if (details.retryable !== undefined) {
    lines.push(`Retryable: ${details.retryable}`);
  }
  if (details.requestId) {
    lines.push(`Request ID: ${details.requestId}`);
  }
  if (details.sdkErrors?.length) {
    lines.push(`SDK errors: ${details.sdkErrors.join("; ")}`);
  }
  if (details.exitCode !== undefined) {
    lines.push(`Exit code: ${details.exitCode}`);
  }
  if (details.stderr) {
    lines.push(`Stderr: ${details.stderr}`);
  }
  if (details.cause) {
    try {
      const causeStr = details.cause instanceof Error
        ? `${details.cause.name}: ${details.cause.message}`
        : JSON.stringify(details.cause);
      lines.push(`Cause: ${causeStr}`);
    } catch {
      lines.push(`Cause: [unserializable: ${typeof details.cause}]`);
    }
  }
  if (details.stack) {
    lines.push(`Stack:\n${details.stack}`);
  }

  return lines.join("\n");
}

export function formatErrorForUser(error: unknown): string {
  const details = extractErrorDetails(error);

  let userMessage = `❌ ${details.name}`;
  if (details.statusCode !== undefined) {
    userMessage += ` [HTTP ${details.statusCode}]`;
  }
  if (details.exitCode !== undefined) {
    userMessage += ` (code ${details.exitCode})`;
  }
  if (details.errorCode) {
    userMessage += ` [${details.errorCode}]`;
  }
  userMessage += `\n${details.message.slice(0, 2000)}`;

  if (details.providerId) {
    userMessage += `\n\nProvider: ${details.providerId}`;
  }
  if (details.retryable !== undefined) {
    userMessage += ` | Retryable: ${details.retryable}`;
  }
  // requestId is internal diagnostic — only in formatErrorForLog, not user-facing
  if (details.sdkErrors?.length) {
    userMessage += `\n\nSDK errors:\n${details.sdkErrors.map((e) => `  - ${e}`).join("\n")}`;
  }

  if (details.stderr) {
    userMessage += `\n\nstderr:\n${details.stderr.slice(0, 500)}`;
  }

  if (details.hint) {
    userMessage += `\n\n💡 ${details.hint}`;
  }

  return userMessage;
}
