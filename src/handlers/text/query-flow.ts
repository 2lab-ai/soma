import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import type { Context } from "grammy";
import { WORKING_DIR } from "../../config";
import { MODEL_DISPLAY_NAMES, getModelForContext } from "../../config/model";
import type { ClaudeSession } from "../../core/session/session";
import { getSessionFilePath, saveSession } from "../../core/session/session-store";
import { Reactions } from "../../constants/reactions";
import { fetchClaudeUsage } from "../../usage";
import { auditLog } from "../../utils/audit";
import { addTimestamp } from "../../utils/interrupt";
import { startTypingIndicator } from "../../utils/typing";
import {
  formatErrorForLog,
  formatErrorForUser,
  formatRateLimitForUser,
  handleAbortError,
  isAbortError,
  isRateLimitError,
  isSdkResumeError,
  isSonnetAvailable,
  isToolUseInvariantError,
} from "../../utils/error-classification";
import { isReentrancyError } from "./query-flow-guard";
import { sendSystemMessage } from "../../utils/system-message";
import { formatSteeringMessages } from "../../core/session/session-helpers";
import {
  StreamingState,
  cleanupToolMessages,
  createStatusCallback,
} from "../streaming";

export interface QueryFlowParams {
  ctx: Context;
  session: ClaudeSession;
  message: string;
  chatId: number;
  userId: number;
  username: string;
  deliverInboundReaction: (reaction: string) => Promise<void>;
}

// Marker returned by interrupt-flow when steering messages remain in buffer.
// When detected, skip the initial Claude query and go straight to auto-continue.
const INTERRUPT_STEERING_MARKER = "[시스템: 인터럽트 후 대기 메시지 처리]";

/**
 * Predicate for the tool-use invariant recovery branch (issue #61).
 *
 * Recovery fires ONLY when ALL four conditions hold:
 *  1. The error matches the tool-use invariant signature.
 *  2. The failing call was a resume (sessionIdAtStart !== null) — fresh
 *     sessions can't produce stale tool_use blocks.
 *  3. Nothing was streamed to the user yet (no text or tool messages).
 *     Mid-stream PreToolUse-block ordering issues are intentionally excluded.
 *  4. We still have retry budget left.
 *
 * Extracted to a pure function so regression tests can exercise each
 * false-positive guard independently without simulating the full query path.
 */
export function shouldRecoverFromToolInvariantError(
  error: unknown,
  sessionIdAtStart: string | null,
  state: Pick<StreamingState, "textMessages" | "toolMessages">,
  attempt: number,
  maxRetries: number
): boolean {
  if (!isToolUseInvariantError(error)) return false;
  if (sessionIdAtStart === null) return false;
  if (state.textMessages.size !== 0) return false;
  if (state.toolMessages.length !== 0) return false;
  if (attempt >= maxRetries) return false;
  return true;
}

/**
 * Disk + in-memory cleanup for the tool-use invariant recovery branch.
 *
 * - Deletes the on-disk session file via `unlinkSync` (ENOENT is silent —
 *   see R2 recovery taxonomy: missing file is not an error).
 * - Clears the in-memory sessionId so the next attempt starts fresh.
 *
 * Extracted to a pure function so regression tests can verify disk cleanup
 * and sessionId reset without driving the whole query flow.
 */
export function performToolInvariantRecovery(
  session: ClaudeSession,
  transcriptPath: string
): void {
  try {
    unlinkSync(transcriptPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[TOOL-INVARIANT-RECOVERY] unlink failed:", err);
    }
  }
  session.sessionId = null;
}

export async function runQueryFlow(params: QueryFlowParams): Promise<void> {
  const { ctx, session, message, chatId, userId, username, deliverInboundReaction } =
    params;
  // Don't pollute lastMessage with synthetic interrupt marker (breaks /retry)
  const isInterruptDrain = message === INTERRUPT_STEERING_MARKER;
  if (!isInterruptDrain) {
    session.lastMessage = message;
  }
  const messageWithTimestamp = addTimestamp(message);
  const stopProcessing = session.startProcessing();

  try {
    await deliverInboundReaction(Reactions.PROCESSING);
  } catch (e) { console.warn("[REACT] deliverInboundReaction failed:", e); }

  const typing = startTypingIndicator(ctx);
  let state = new StreamingState();
  let statusCallback = await createStatusCallback(ctx, state, session);
  const MAX_RETRIES = 1;

  try {
    // When interrupt drains steering, skip initial query — go straight to auto-continue loop
    if (isInterruptDrain) {
      console.log("[QUERY-FLOW] Interrupt drain mode: skipping initial query, entering auto-continue");
    }

    let recoveryNoticePending = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Capture sessionId BEFORE the query so the tool-use-invariant recovery
      // branch can tell whether the failing call was a resume vs. a fresh session.
      const sessionIdAtStart = session.sessionId;

      // Persist the model bound to the current sessionId before the query runs.
      // Without this, a bot restart after a model change (e.g. Opus 4.6 → 4.7)
      // resumes a sessionId whose persisted model no longer matches the
      // configured effective model, causing SDK invariant 400s (issue #61).
      const effectiveModel =
        session.temporaryModelOverride ?? getModelForContext("general");
      if (session.getLastUsedModel() !== effectiveModel) {
        session.setLastUsedModel(effectiveModel);
        saveSession(session.sessionKey, session);
      }

      try {
        // Notify user once that the previous turn was auto-recovered, just before
        // the retry stream begins (first text message of the new attempt).
        if (recoveryNoticePending) {
          recoveryNoticePending = false;
          try {
            await sendSystemMessage(ctx, "🔄 세션 자동 복구됨");
          } catch (e) { console.warn("[TOOL-INVARIANT-RECOVERY] notice failed:", e); }
        }

        if (!isInterruptDrain) {
          const response = await session.sendMessageStreaming(
            messageWithTimestamp,
            statusCallback,
            chatId,
            "general",
            userId
          );

          await auditLog(userId, username, "TEXT", message, response);

          try {
            await deliverInboundReaction(Reactions.COMPLETE);
          } catch (e) { console.warn("[REACT] complete reaction failed:", e); }
        } // end if (!isInterruptDrain)

        const MAX_AUTO_CONTINUE_ROUNDS = 5;
        let autoContinueRound = 0;

        // Fix soma-uqb9: For text-only responses, PostToolUse hook never fires,
        // so messages remain in steeringBuffer (not tracked via injectedSteering).
        // Previously we called trackBufferedMessagesForInjection() here, but that
        // COPIES to injectedSteering without clearing the buffer. Then
        // restoreInjectedSteering() merges injected BACK into the still-populated
        // buffer, duplicating every message (3 messages → 6).
        //
        // Fix: Skip the track→restore round-trip entirely for text-only responses.
        // The auto-continue loop below already consumes directly from the buffer.
        // For tool-use responses, postToolUseHook handles track+consume correctly.

        // Fix #24: If user issued /stop, abort was suppressed in sendMessageStreaming
        // but we must NOT continue processing steering messages.
        if (session.wasStoppedByUser) {
          console.log("[AUTO-CONTINUE] Skipping — user issued /stop");
          const discarded = session.extractSteeringMessages();
          if (discarded.length > 0) {
            console.log(`[AUTO-CONTINUE] Discarded ${discarded.length} steering message(s) due to /stop`);
          }
          break;
        }

        while (true) {
          // Fix #24: Check FIRST if user stopped — before any buffer work
          if (session.wasStoppedByUser) {
            console.log(`[AUTO-CONTINUE] Breaking loop — user issued /stop during round ${autoContinueRound}`);
            session.extractSteeringMessages(); // drain both stores
            break;
          }

          // Restore any injected messages from tool-use hooks back to buffer
          // (only relevant when postToolUseHook ran during the query)
          const bufferBeforeRestore = session.getSteeringCount();
          const restoredCount = session.restoreInjectedSteering();
          const bufferAfterRestore = session.getSteeringCount();
          console.log(
            `[STEERING DEBUG] Round ${autoContinueRound}: Before restore: ${bufferBeforeRestore}, Restored: ${restoredCount}, After: ${bufferAfterRestore}`
          );

          const hasSteering = session.hasSteeringMessages();
          console.log(
            `[AUTO-CONTINUE] Round ${autoContinueRound}: hasSteeringMessages() = ${hasSteering}, buffer count = ${session.getSteeringCount()}`
          );

          if (!hasSteering) {
            if (autoContinueRound === 0) {
              console.log("[AUTO-CONTINUE] No pending steering messages");
            } else {
              console.log(
                `[AUTO-CONTINUE] Drained all steering after ${autoContinueRound} round(s)`
              );
            }
            break;
          }

          if (autoContinueRound >= MAX_AUTO_CONTINUE_ROUNDS) {
            console.warn(
              `[AUTO-CONTINUE] Hit max rounds (${MAX_AUTO_CONTINUE_ROUNDS}), stopping. Remaining buffer: ${session.getSteeringCount()}`
            );
            break;
          }

          autoContinueRound++;
          const steeringCount = session.getSteeringCount();
          console.log(
            `[AUTO-CONTINUE] Round ${autoContinueRound}: Processing ${steeringCount} pending message(s)`
          );

          const steeringResult = session.consumeSteeringWithIds();
          console.log(
            `[AUTO-CONTINUE] Round ${autoContinueRound}: Consumed: "${steeringResult?.formatted.slice(0, 100)}..."`
          );

          if (!steeringResult) {
            console.warn(
              "[AUTO-CONTINUE] consumeSteeringWithIds returned null despite hasSteering=true"
            );
            break;
          }

          const { formatted: steeringContent, messageIds: steeringMsgIds } = steeringResult;

          // Mark consumed steering messages as DELIVERED (👌 → 🙏)
          for (const msgId of steeringMsgIds) {
            try {
              await ctx.api.setMessageReaction(chatId, msgId, [
                { type: "emoji", emoji: Reactions.STEERING_DELIVERED },
              ]);
            } catch {
              // Rate limited or not allowed — non-critical
            }
          }

          try {
            await sendSystemMessage(
              ctx,
              `💬 <i>대기 메시지 ${steeringCount}개 처리 중...</i>`,
              {
                parse_mode: "HTML",
              }
            );
          } catch (e) { console.warn("[SYSTEM-MSG] steering notification failed:", e); }

          const followUpMessage = `[이전 응답 중 보낸 메시지 - 지금 처리합니다]\n${steeringContent}`;

          const followUpState = new StreamingState();
          const followUpCallback = await createStatusCallback(
            ctx,
            followUpState,
            session
          );

          try {
            console.log(
              `[AUTO-CONTINUE] Round ${autoContinueRound}: Sending follow-up query...`
            );
            const followUpResponse = await session.sendMessageStreaming(
              followUpMessage,
              followUpCallback,
              chatId,
              "general",
              userId
            );
            console.log(
              `[AUTO-CONTINUE] Round ${autoContinueRound}: Follow-up complete, response length: ${followUpResponse.length}`
            );

            // Mark consumed steering messages as COMPLETE (🙏 → 👍)
            for (const msgId of steeringMsgIds) {
              try {
                await ctx.api.setMessageReaction(chatId, msgId, [
                  { type: "emoji", emoji: Reactions.COMPLETE },
                ]);
              } catch {}
            }

            await auditLog(
              userId,
              username,
              "STEERING_FOLLOWUP",
              steeringContent,
              followUpResponse
            );
            await Bun.sleep(500);
          } catch (followUpError) {
            // Fix #24: Distinguish user-initiated stop from real failures
            if (session.wasStoppedByUser || isAbortError(followUpError)) {
              console.log(
                `[AUTO-CONTINUE] Round ${autoContinueRound}: Follow-up stopped by user`
              );
              break;
            }

            console.error(
              `[AUTO-CONTINUE] Round ${autoContinueRound}: Follow-up FAILED:`,
              followUpError
            );

            // Mark consumed steering messages as ERROR (🙏 → 💩)
            for (const msgId of steeringMsgIds) {
              try {
                await ctx.api.setMessageReaction(chatId, msgId, [
                  { type: "emoji", emoji: Reactions.ERROR_MODEL },
                ]);
              } catch {}
            }

            await sendSystemMessage(
              ctx,
              "⚠️ 대기 중인 메시지 처리 실패. 다시 보내주세요."
            );
            break;
          }
        }

        if (session.needsSave) {
          const currentTokens = session.currentContextTokens;
          const windowSize = session.actualContextMax ?? session.contextWindowSize;
          const percentage = windowSize > 0 ? ((currentTokens / windowSize) * 100).toFixed(1) : "?";
          await sendSystemMessage(
            ctx,
            `⚠️ **Context Limit Approaching**\n\n` +
              `Current: ${currentTokens.toLocaleString()} / ${windowSize.toLocaleString()} tokens (${percentage}%)\n\n` +
              `Initiating automatic save...`,
            { parse_mode: "Markdown" }
          );

          try {
            const saveResponse = await session.sendMessageStreaming(
              "Context limit reached. Execute: Skill tool with skill='oh-my-claude:save'",
              async () => {},
              chatId,
              "general",
              userId
            );

            const saveIdMatch = saveResponse.match(
              /Saved to:.*?\/docs\/tasks\/save\/(\d{8}_\d{6})\//
            );
            if (saveIdMatch && saveIdMatch[1]) {
              const saveId = saveIdMatch[1];
              if (!/^\d{8}_\d{6}$/.test(saveId)) {
                console.error(`Invalid save ID format: ${saveId}`);
                console.error(`Full response: ${saveResponse}`);
                await ctx.reply(
                  `❌ Save ID validation failed: ${saveId}\n\nFull response logged.`
                );
                break;
              }

              const saveIdFile = `${WORKING_DIR}/.last-save-id`;
              writeFileSync(saveIdFile, saveId, "utf-8");

              if (
                !existsSync(saveIdFile) ||
                readFileSync(saveIdFile, "utf-8").trim() !== saveId
              ) {
                const error = "Failed to persist save ID - file not written correctly";
                console.error(error);
                await ctx.reply(`❌ ${error}`);
                throw new Error(error);
              }

              console.log(`✅ Save ID captured & verified: ${saveId} → ${saveIdFile}`);
              console.log("[TELEMETRY] auto_save_success", {
                saveId,
                contextTokens: currentTokens,
                timestamp: new Date().toISOString(),
              });

              await sendSystemMessage(
                ctx,
                `✅ **Context Saved**\n\n` +
                  `Save ID: \`${saveId}\`\n\n` +
                  `Please run: \`make up\` to restart with restored context.`,
                { parse_mode: "Markdown" }
              );
            } else {
              console.warn(
                "Failed to parse save_id from response:",
                saveResponse.slice(0, 200)
              );
              await ctx.reply(
                `⚠️ Save completed but couldn't parse save ID. Response: ${saveResponse.slice(0, 200)}`
              );
            }
          } catch (error) {
            console.error("CRITICAL: Auto-save failed:", error);
            console.error("Stack:", error instanceof Error ? error.stack : "N/A");

            const errorStr = String(error);
            const sanitized = errorStr.replace(
              process.env.HOME || "/home/zhugehyuk",
              "~"
            );

            await sendSystemMessage(
              ctx,
              `🚨 **CRITICAL: Auto-Save Failed**\n\n` +
                `Error: ${sanitized.slice(0, 300)}\n\n` +
                `⚠️ **YOUR WORK IS NOT SAVED**\n\n` +
                `Do NOT restart. Try manual: /oh-my-claude:save`,
              { parse_mode: "Markdown" }
            );
          }
        }

        break;
      } catch (error) {
        if (isReentrancyError(error)) {
          console.warn(`[QUERY] Re-entrancy guard hit, buffering as steering: "${message.slice(0, 50)}"`);
          const msgId = ctx.message?.message_id ?? 0;
          session.addSteering(message, msgId);
          try {
            await sendSystemMessage(ctx, "⏳ 이전 요청 처리 중입니다. 메시지가 대기열에 추가되었습니다.");
          } catch (e) { console.warn("[SYSTEM-MSG] steering queue notification failed:", e); }
          return;
        }

        const errorStr = String(error);

        // Auto-retry on expired session ID (soma-nok6)
        if (errorStr.includes("SESSION_EXPIRED") && attempt < MAX_RETRIES) {
          console.log(`[SESSION-RESUME] Session expired, auto-retrying as new session (attempt ${attempt + 1})`);
          cleanupToolMessages(ctx, state.toolMessages);
          state.cleanup();
          state = new StreamingState();
          statusCallback = await createStatusCallback(ctx, state, session);
          continue;
        }

        // Auto-retry on SDK resume errors: EISDIR or streaming mode mismatch (soma-eisdir-resume)
        // SDK sometimes fails during session resume when session state references a
        // directory instead of a file. Fix: clear sessionId and retry as new session.
        if (isSdkResumeError(error) && attempt < MAX_RETRIES) {
          console.log(`[SESSION-RESUME] SDK resume error (EISDIR/streaming), resetting session and retrying as new (attempt ${attempt + 1})`);
          session.sessionId = null;
          cleanupToolMessages(ctx, state.toolMessages);
          state.cleanup();
          state = new StreamingState();
          statusCallback = await createStatusCallback(ctx, state, session);
          continue;
        }

        // Auto-recover from tool-use invariant violations on resume (issue #61).
        // See shouldRecoverFromToolInvariantError for the 4-AND guard rationale
        // and performToolInvariantRecovery for the disk+memory cleanup.
        if (
          shouldRecoverFromToolInvariantError(
            error,
            sessionIdAtStart,
            state,
            attempt,
            MAX_RETRIES
          )
        ) {
          const transcriptPath = getSessionFilePath(session.sessionKey);
          console.error("[TOOL-INVARIANT-RECOVERY]", {
            sessionId: sessionIdAtStart,
            resumeWasUsed: true,
            noOutputBeforeError: true,
            textMessageCount: state.textMessages.size,
            toolMessageCount: state.toolMessages.length,
            transcriptPath,
            lastUsedModel: (session as unknown as { lastUsedModel?: string | null })
              .lastUsedModel,
            rawError: errorStr.slice(0, 500),
          });
          performToolInvariantRecovery(session, transcriptPath);
          cleanupToolMessages(ctx, state.toolMessages);
          state.cleanup();
          state = new StreamingState();
          statusCallback = await createStatusCallback(ctx, state, session);
          recoveryNoticePending = true;
          continue;
        }

        const isClaudeCodeCrash = errorStr.includes("exited with code");

        cleanupToolMessages(ctx, state.toolMessages);

        if (isClaudeCodeCrash) {
          const exitCodeMatch = errorStr.match(/exited with code (\d+)/);
          const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : null;
          console.error(`[CRASH] Claude Code crashed: exit_code=${exitCode}, error=${errorStr}`);

          // Preserve steering messages before kill() clears them
          const killResult = await session.kill();
          session.clearStopRequested();

          // Preserve lost steering messages as context for next query (user-bound)
          if (killResult.count > 0) {
            const preserved = formatSteeringMessages(killResult.messages);
            const existingCtx = session.nextQueryContext?.userId === userId
              ? session.nextQueryContext.context
              : "";
            session.nextQueryContext = {
              userId,
              context: existingCtx
                ? `${existingCtx}\n[CRASH RECOVERY - ${killResult.count} message(s)]\n${preserved}\n[END RECOVERY]`
                : `[CRASH RECOVERY - ${killResult.count} message(s)]\n${preserved}\n[END RECOVERY]`,
            };
            console.warn(
              `[CRASH-RECOVERY] Preserved ${killResult.count} steering message(s) as nextQueryContext`
            );
          }

          // Preserve user's original message as context for next interaction
          // NOTE: We do NOT auto-retry because tools may have already executed
          // during the crashed turn — replaying would cause non-idempotent side effects.
          if (!isInterruptDrain) {
            const existingCtx = session.nextQueryContext?.userId === userId
              ? session.nextQueryContext.context
              : "";
            const crashContext = `[SYSTEM: Previous query crashed (exit code ${exitCode ?? "unknown"}). The user's message below was being processed when the crash occurred.]\n${message}`;
            session.nextQueryContext = {
              userId,
              context: existingCtx
                ? `${existingCtx}\n${crashContext}`
                : crashContext,
            };
          }

          const shortError = errorStr.slice(0, 800);
          try {
            await sendSystemMessage(
              ctx,
              `💥 **Claude Code crashed** (exit ${exitCode ?? "?"})\n\n` +
                `\`\`\`\n${shortError}\n\`\`\`\n\n` +
                `세션 초기화됨. 다음 메시지에 이전 문맥이 자동 포함됩니다.` +
                (killResult.count > 0 ? `\n⚠️ 대기 중이던 ${killResult.count}개 메시지도 보존됨.` : ""),
              { parse_mode: "Markdown" }
            );
          } catch (notifyErr) {
            console.warn("[CRASH-RECOVERY] Failed to notify user:", notifyErr);
          }
          break;
        }

        const rateLimitInfo = isRateLimitError(error);
        if (rateLimitInfo.isRateLimit) {
          console.log(`[RATE-LIMIT] Detected: bucket=${rateLimitInfo.bucket}`);
          session.rateLimitState.consecutiveFailures++;

          const usage = await fetchClaudeUsage(10);
          const richMessage = await formatRateLimitForUser(error, usage);

          if (
            session.rateLimitState.cooldownUntil &&
            Date.now() < session.rateLimitState.cooldownUntil
          ) {
            await ctx.reply(
              richMessage + "\n\n🛑 연속 실패로 대기 중. 잠시 후 다시 시도해주세요."
            );
            break;
          }

          if (session.rateLimitState.consecutiveFailures >= 3) {
            session.rateLimitState.cooldownUntil = Date.now() + 5 * 60 * 1000;
            await ctx.reply(
              richMessage + "\n\n🛑 연속 3회 실패. 5분 후 다시 시도해주세요."
            );
            break;
          }

          // Only attempt Sonnet fallback if:
          // 1. No temporary override is active
          // 2. Sonnet quota is available
          // 3. Current effective model is NOT already Sonnet (e.g. user switched via /model)
          const currentEffectiveModel = session.temporaryModelOverride ?? getModelForContext("general");
          const alreadyOnSonnet = currentEffectiveModel === "claude-sonnet-4-5-20250929";
          if (!session.temporaryModelOverride && !alreadyOnSonnet && usage && isSonnetAvailable(usage)) {
            const sonnetModel = "claude-sonnet-4-5-20250929" as const;
            session.temporaryModelOverride = sonnetModel;

            if (usage.five_hour?.resets_at) {
              session.rateLimitState.opusResetsAt = usage.five_hour.resets_at;
            }

            const sonnetPct = usage.seven_day_sonnet
              ? `${Math.round(usage.seven_day_sonnet.utilization * 100)}%`
              : "?";

            await sendSystemMessage(
              ctx,
              richMessage +
                `\n\n💡 Sonnet 사용량 ${sonnetPct} → 자동 전환합니다.` +
                `\n🔄 메시지 재전송 중...`
            );

            state.cleanup();
            state = new StreamingState();
            statusCallback = await createStatusCallback(ctx, state, session);

            try {
              const retryResponse = await session.sendMessageStreaming(
                messageWithTimestamp,
                statusCallback,
                chatId,
                "general",
                userId
              );
              await auditLog(userId, username, "TEXT_FALLBACK", message, retryResponse);
              try {
                await deliverInboundReaction(Reactions.COMPLETE);
              } catch (e) { console.warn("[REACT] fallback complete reaction failed:", e); }

              const fallbackModel = session.temporaryModelOverride;
              const modelName = fallbackModel
                ? MODEL_DISPLAY_NAMES[fallbackModel] || fallbackModel
                : "Sonnet";
              await sendSystemMessage(
                ctx,
                `✅ ${modelName}으로 응답 완료. Opus 복구 시 자동 전환됩니다.`
              );
              session.rateLimitState.consecutiveFailures = 0;
              break;
            } catch (retryError) {
              console.error("[RATE-LIMIT] Sonnet fallback also failed:", retryError);
              session.rateLimitState.consecutiveFailures++;
              const retryRateLimitInfo = isRateLimitError(retryError);
              if (retryRateLimitInfo.isRateLimit) {
                const retryUsage = await fetchClaudeUsage(10);
                const retryMessage = await formatRateLimitForUser(
                  retryError,
                  retryUsage
                );
                await ctx.reply(
                  retryMessage + "\n\n🛑 Sonnet도 한도 초과. 잠시 후 다시 시도해주세요."
                );
              } else {
                await ctx.reply(formatErrorForUser(retryError));
              }
              break;
            }
          }

          await ctx.reply(richMessage);
          break;
        }

        console.error(formatErrorForLog(error));

        // User abort: skip steering preservation — user wants to STOP, not continue
        if (isAbortError(error)) {
          console.log("[QUERY-FLOW] User abort detected — skipping steering preservation");
          // Drain both steeringBuffer and injectedSteeringDuringQuery (fix #32)
          const discarded = session.extractSteeringMessages();
          if (discarded.length > 0) {
            console.log(`[QUERY-FLOW] Discarded ${discarded.length} steering message(s) due to user abort`);
          }
          await handleAbortError(ctx, error, session);
          break;
        }

        // Drain BOTH steeringBuffer and injectedSteeringDuringQuery (fix #32)
        const lostMessages = session.extractSteeringMessages();
        if (lostMessages.length > 0) {
          const preserved = formatSteeringMessages(lostMessages);
          const existingCtx = session.nextQueryContext?.userId === userId
            ? session.nextQueryContext.context
            : "";
          session.nextQueryContext = {
            userId,
            context: existingCtx
              ? `${existingCtx}\n[ERROR RECOVERY - ${lostMessages.length} message(s)]\n${preserved}\n[END RECOVERY]`
              : `[ERROR RECOVERY - ${lostMessages.length} message(s)]\n${preserved}\n[END RECOVERY]`,
          };
          console.warn(
            `[STEERING] Preserved ${lostMessages.length} message(s) as nextQueryContext due to error`
          );
          try {
            await ctx.reply(
              `⚠️ 에러 발생. 대기 중이던 ${lostMessages.length}개 메시지가 다음 요청에 자동 포함됩니다.`
            );
          } catch (notifyError) {
            console.error("[STEERING] Failed to notify user of error recovery:", notifyError);
          }
        }

        if (!(await handleAbortError(ctx, error, session))) {
          try {
            await deliverInboundReaction(Reactions.ERROR_MODEL);
          } catch (e) { console.warn("[REACT] error reaction failed:", e); }
          await ctx.reply(formatErrorForUser(error));
        }
        break;
      }
    }
  } finally {
    state.cleanup();
    stopProcessing();
    typing.stop();
  }
}
