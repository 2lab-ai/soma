/**
 * Shared poisoned-resume recovery.
 *
 * A "poisoned resume" is a resumed session whose on-disk transcript makes
 * Anthropic reject the request with a 400 at validation time, BEFORE any output
 * streams — permanently blocking the session until the transcript is discarded.
 * Two error families share this exact failure + recovery shape:
 *  - tool-use invariant (issue #61): stale tool_use without matching tool_result.
 *  - thinking-block invariant: `thinking`/`redacted_thinking` block not first or
 *    modified, typically after a model flip changes the thinking config.
 *
 * The recovery (delete transcript → clear sessionId → retry once as a fresh
 * session) used to live only inside runQueryFlow, so every other entry point
 * that resumes the same session (voice, photo, document, callback, direct-input,
 * scheduler, boot) stayed poisoned. `withPoisonedResumeRecovery` lifts the
 * behaviour into one wrapper those callers share.
 */
import { unlinkSync } from "fs";
import type { ClaudeSession } from "../../core/session/session";
import { getSessionFilePath } from "../../core/session/session-store";
import {
  isThinkingBlockInvariantError,
  isToolUseInvariantError,
} from "../../utils/error-classification";

/**
 * True when the error is a poisoned-resume 400 from either invariant family.
 */
export function isPoisonedResumeError(error: unknown): boolean {
  return isToolUseInvariantError(error) || isThinkingBlockInvariantError(error);
}

/**
 * Disk + in-memory cleanup for a poisoned resume.
 *
 * - Deletes the on-disk session file via `unlinkSync` (ENOENT is silent —
 *   missing file is not an error).
 * - Clears the in-memory sessionId so the next attempt starts fresh.
 */
export function performPoisonedResumeRecovery(
  session: ClaudeSession,
  transcriptPath: string
): void {
  try {
    unlinkSync(transcriptPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[POISONED-RESUME-RECOVERY] unlink failed:", err);
    }
  }
  session.sessionId = null;
}

export interface PoisonedResumeRecoveryOptions {
  /**
   * Defensive guard mirroring runQueryFlow's "nothing streamed yet" check.
   * The 400 fires before any stream event, so the genuine case is always
   * recoverable — but a caller that has already shown output to the user should
   * pass `() => state.textMessages.size === 0 && state.toolMessages.length === 0`
   * so a mid-stream failure is surfaced instead of silently retried. Defaults to
   * always-recoverable for callers with a no-op status callback (scheduler/boot).
   */
  canRecover?: () => boolean;
  /** Side effect after recovery, before the retry (e.g. user notice / log). */
  onRecover?: () => void | Promise<void>;
  /** Entry-point label for the recovery log line (e.g. "voice", "photo"). */
  label?: string;
}

/**
 * Run `run()` and, if it fails with a poisoned-resume 400 on a session that was
 * being resumed, discard the transcript and retry `run()` exactly once as a
 * fresh session. Any other error — or a second failure — is rethrown.
 *
 * runQueryFlow keeps its own richer recovery (it drives a multi-segment
 * streaming loop with StreamingState cleanup); this wrapper covers the
 * single-shot `await session.sendMessageStreaming(...)` callers.
 */
export async function withPoisonedResumeRecovery<T>(
  session: ClaudeSession,
  run: () => Promise<T>,
  opts: PoisonedResumeRecoveryOptions = {}
): Promise<T> {
  // Capture BEFORE the call: a fresh session (null) can't have a poisoned
  // transcript, so only a resume is eligible for recovery.
  const sessionIdAtStart = session.sessionId;
  try {
    return await run();
  } catch (error) {
    if (
      !isPoisonedResumeError(error) ||
      sessionIdAtStart === null ||
      !(opts.canRecover?.() ?? true)
    ) {
      throw error;
    }

    const transcriptPath = getSessionFilePath(session.sessionKey);
    console.error("[POISONED-RESUME-RECOVERY]", {
      label: opts.label ?? "unknown",
      sessionId: sessionIdAtStart,
      resumeWasUsed: true,
      isToolUseInvariant: isToolUseInvariantError(error),
      isThinkingBlockInvariant: isThinkingBlockInvariantError(error),
      transcriptPath,
      lastUsedModel: session.getLastUsedModel(),
      rawError: String(error).slice(0, 500),
    });
    performPoisonedResumeRecovery(session, transcriptPath);
    await opts.onRecover?.();

    // Single fresh retry. A second failure falls through to the caller.
    return await run();
  }
}
