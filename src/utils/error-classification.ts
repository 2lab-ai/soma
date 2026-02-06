/**
 * Error classification utilities for consistent error handling across handlers
 */

import type { Context } from "grammy";
import type { ClaudeSession } from "../session";
import { Reactions } from "../constants/reactions";
import { sendSystemMessage } from "./system-message";

/**
 * Check if an error is an abort/cancellation error
 * Handles both DOMException.AbortError and Node.js AbortError
 */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // Check error name first (most reliable)
  if (error.name === "AbortError") return true;

  // Check for exact abort/cancel messages only (avoid partial matches)
  const msg = error.message.toLowerCase();
  return (
    msg === "aborted" ||
    msg === "cancelled" ||
    msg === "canceled" ||
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

  if (details.exitCode !== undefined) {
    lines.push(`Exit code: ${details.exitCode}`);
  }
  if (details.stderr) {
    lines.push(`Stderr: ${details.stderr}`);
  }
  if (details.cause) {
    lines.push(`Cause: ${JSON.stringify(details.cause)}`);
  }
  if (details.stack) {
    lines.push(`Stack:\n${details.stack}`);
  }

  return lines.join("\n");
}

export function formatErrorForUser(error: unknown): string {
  const details = extractErrorDetails(error);

  let userMessage = `❌ ${details.name}`;
  if (details.exitCode !== undefined) {
    userMessage += ` (code ${details.exitCode})`;
  }
  userMessage += `\n${details.message.slice(0, 150)}`;

  if (details.hint) {
    userMessage += `\n\n💡 ${details.hint}`;
  }

  return userMessage;
}
