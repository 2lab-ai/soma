import { existsSync, readFileSync, writeFileSync } from "fs";
import type { Context } from "grammy";
import { WORKING_DIR } from "../../config";
import { MODEL_DISPLAY_NAMES } from "../../config/model";
import type { ClaudeSession } from "../../core/session/session";
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
  isRateLimitError,
  isSonnetAvailable,
} from "../../utils/error-classification";
import { sendSystemMessage } from "../../utils/system-message";
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

export async function runQueryFlow(params: QueryFlowParams): Promise<void> {
  const { ctx, session, message, chatId, userId, username, deliverInboundReaction } =
    params;
  session.lastMessage = message;
  const messageWithTimestamp = addTimestamp(message);
  const stopProcessing = session.startProcessing();

  try {
    await deliverInboundReaction(Reactions.PROCESSING);
  } catch {}

  const typing = startTypingIndicator(ctx);
  let state = new StreamingState();
  let statusCallback = await createStatusCallback(ctx, state, session);
  const MAX_RETRIES = 1;

  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await session.sendMessageStreaming(
          messageWithTimestamp,
          statusCallback,
          chatId
        );

        await auditLog(userId, username, "TEXT", message, response);

        try {
          await deliverInboundReaction(Reactions.COMPLETE);
        } catch {}

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

        while (true) {
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

          const steeringContent = session.consumeSteering();
          console.log(
            `[AUTO-CONTINUE] Round ${autoContinueRound}: Consumed: "${steeringContent?.slice(0, 100)}..."`
          );

          if (!steeringContent) {
            console.warn(
              "[AUTO-CONTINUE] consumeSteering returned null/empty despite hasSteering=true"
            );
            break;
          }

          try {
            await sendSystemMessage(
              ctx,
              `💬 <i>대기 메시지 ${steeringCount}개 처리 중...</i>`,
              {
                parse_mode: "HTML",
              }
            );
          } catch {}

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
              chatId
            );
            console.log(
              `[AUTO-CONTINUE] Round ${autoContinueRound}: Follow-up complete, response length: ${followUpResponse.length}`
            );
            await auditLog(
              userId,
              username,
              "STEERING_FOLLOWUP",
              steeringContent,
              followUpResponse
            );
            await Bun.sleep(500);
          } catch (followUpError) {
            console.error(
              `[AUTO-CONTINUE] Round ${autoContinueRound}: Follow-up FAILED:`,
              followUpError
            );
            await sendSystemMessage(
              ctx,
              "⚠️ 대기 중인 메시지 처리 실패. 다시 보내주세요."
            );
            break;
          }
        }

        if (session.needsSave) {
          const currentTokens = session.currentContextTokens;
          const windowSize = session.contextWindowSize;
          const percentage = ((currentTokens / windowSize) * 100).toFixed(1);
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
              chatId
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
        const errorStr = String(error);
        const isClaudeCodeCrash = errorStr.includes("exited with code");

        cleanupToolMessages(ctx, state.toolMessages);

        if (isClaudeCodeCrash) {
          console.error(`[CRASH] Claude Code crashed: ${errorStr}`);
          await session.kill();
          session.clearStopRequested();
          const shortError = errorStr.slice(0, 500);
          await sendSystemMessage(
            ctx,
            `💥 **Claude Code Exception**\n\n` +
              `\`\`\`\n${shortError}\n\`\`\`\n\n` +
              `Session cleared. Send a new message to start fresh.`,
            { parse_mode: "Markdown" }
          );
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

          if (!session.temporaryModelOverride && usage && isSonnetAvailable(usage)) {
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
                chatId
              );
              await auditLog(userId, username, "TEXT_FALLBACK", message, retryResponse);
              try {
                await deliverInboundReaction(Reactions.COMPLETE);
              } catch {}

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

        if (session.hasSteeringMessages()) {
          const lostCount = session.getSteeringCount();
          session.consumeSteering();
          console.warn(`[STEERING] Cleared ${lostCount} message(s) due to error`);
          await ctx.reply(
            `⚠️ 에러로 인해 대기 중이던 ${lostCount}개 메시지가 처리되지 않았습니다. 다시 보내주세요.`
          );
        }

        if (!(await handleAbortError(ctx, error, session))) {
          try {
            await deliverInboundReaction(Reactions.ERROR_MODEL);
          } catch {}
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
