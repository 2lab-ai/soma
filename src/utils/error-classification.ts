/**
 * Error classification utilities for consistent error handling across handlers
 */

import type { Context } from "grammy";
import type { ClaudeSession } from "../session";

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

  // Only show "Query stopped" if it was an explicit stop, not an interrupt
  const wasInterrupt = session.consumeInterruptFlag();
  if (!wasInterrupt) {
    await ctx.reply("🛑 Query stopped.");
  }
  return true;
}
