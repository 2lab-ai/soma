/**
 * Text message handler for Claude Telegram Bot.
 */

import type { Context } from "grammy";
import { sessionManager } from "../session-manager";
import { WORKING_DIR } from "../config";
import { sendSystemMessage } from "../utils/system-message";
import {
  type ChatType,
  isAuthorizedForChat,
  rateLimiter,
  shouldRespond,
} from "../security";
import { writeFileSync, existsSync, readFileSync } from "fs";
import {
  addTimestamp,
  auditLog,
  auditLogRateLimit,
  checkInterrupt,
  startTypingIndicator,
} from "../utils";
import { StreamingState, createStatusCallback, cleanupToolMessages } from "./streaming";
import {
  handleAbortError,
  formatErrorForLog,
  formatErrorForUser,
  isRateLimitError,
  formatRateLimitForUser,
  isSonnetAvailable,
} from "../utils/error-classification";
import { fetchClaudeUsage } from "../usage";
import { MODEL_DISPLAY_NAMES } from "../model-config";
import type { ClaudeSession } from "../session";
import { TelegramChoiceBuilder } from "../utils/telegram-choice-builder";
import { Reactions } from "../constants/reactions";

const DIRECT_INPUT_EXPIRY_MS = 5 * 60 * 1000;

interface DirectInputResult {
  handled: boolean;
}

async function editMessageSilently(
  ctx: Context,
  chatId: number,
  messageId: number,
  text: string
): Promise<void> {
  try {
    await ctx.api.editMessageText(chatId, messageId, text);
  } catch (error) {
    console.error("Failed to update direct input message:", error);
    // Inform user that update failed but input was received
    await ctx.reply("✓ Answer recorded (display update failed)").catch(() => {});
  }
}

function isExpired(createdAt: number): boolean {
  return Date.now() - createdAt > DIRECT_INPUT_EXPIRY_MS;
}

async function handleDirectInput(
  ctx: Context,
  session: ClaudeSession,
  chatId: number,
  message: string,
  username: string,
  userId: number
): Promise<DirectInputResult> {
  const directInput = session.pendingDirectInput!;

  if (isExpired(directInput.createdAt)) {
    session.clearDirectInput();
    session.clearChoiceState();
    await sendSystemMessage(ctx, "⏱️ Direct input expired (5 min). Please ask again.");
    return { handled: true };
  }

  session.clearDirectInput();

  let selectedLabel: string;

  if (directInput.type === "single") {
    selectedLabel = message;
    session.clearChoiceState();
    session.setActivityState("working");
  } else {
    const result = await handleMultiFormInput(
      ctx,
      session,
      chatId,
      directInput,
      message
    );
    if (!result.complete) return { handled: true };
    selectedLabel = result.selectedLabel;
  }

  await editMessageSilently(
    ctx,
    chatId,
    directInput.messageId,
    `✓ ${selectedLabel.slice(0, 200)}`
  );
  await sendDirectInputToClaude(
    ctx,
    session,
    selectedLabel,
    username,
    userId,
    chatId,
    message
  );
  return { handled: true };
}

interface MultiFormResult {
  complete: boolean;
  selectedLabel: string;
}

async function handleMultiFormInput(
  ctx: Context,
  session: ClaudeSession,
  chatId: number,
  directInput: NonNullable<ClaudeSession["pendingDirectInput"]>,
  message: string
): Promise<MultiFormResult> {
  if (!session.choiceState || !directInput.questionId) {
    await sendSystemMessage(ctx, "⚠️ Form expired. Please ask again.");
    return { complete: false, selectedLabel: "" };
  }

  const choices = session.choiceState.extractedChoices;
  if (!choices) {
    await sendSystemMessage(ctx, "⚠️ Form data not found.");
    return { complete: false, selectedLabel: "" };
  }

  const question = choices.questions.find((q) => q.id === directInput.questionId);
  if (!question) {
    await sendSystemMessage(ctx, "⚠️ Invalid question ID.");
    return { complete: false, selectedLabel: "" };
  }

  if (!session.choiceState.selections) {
    session.choiceState.selections = {};
  }
  session.choiceState.selections[directInput.questionId] = {
    choiceId: "__direct__",
    label: message,
  };

  const allAnswered =
    Object.keys(session.choiceState.selections).length === choices.questions.length;

  if (!allAnswered) {
    await editMessageSilently(
      ctx,
      chatId,
      directInput.messageId,
      `✓ ${message.slice(0, 100)}`
    );
    await ctx.reply("👌 Answer recorded. Continue with other questions.");
    return { complete: false, selectedLabel: "" };
  }

  const answers = choices.questions
    .map((q) => {
      const sel = session.choiceState?.selections?.[q.id];
      return sel ? `${q.question}: ${sel.label}` : null;
    })
    .filter(Boolean)
    .join("\n");

  session.clearChoiceState();
  session.setActivityState("working");
  return { complete: true, selectedLabel: `Answered all questions:\n${answers}` };
}

async function sendDirectInputToClaude(
  ctx: Context,
  session: ClaudeSession,
  selectedLabel: string,
  username: string,
  userId: number,
  chatId: number,
  originalMessage: string
): Promise<void> {
  // Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await sendSystemMessage(ctx, `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`);
    return;
  }

  const typing = startTypingIndicator(ctx);
  const state = new StreamingState();
  const statusCallback = await createStatusCallback(ctx, state, session);

  try {
    const response = await session.sendMessageStreaming(
      selectedLabel,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );
    await auditLog(userId, username, "DIRECT_INPUT", originalMessage, response);
  } catch (error) {
    console.error(formatErrorForLog(error));

    session.setActivityState("idle");
    cleanupToolMessages(ctx, state.toolMessages);

    if (!(await handleAbortError(ctx, error, session))) {
      await ctx.reply(formatErrorForUser(error));
    }
  } finally {
    state.cleanup();
    typing.stop();
  }
}

// Bot username (set by index.ts after bot info is fetched)
export let botUsername = "";
export function setBotUsername(username: string): void {
  botUsername = username;
}

/**
 * Handle incoming text messages.
 */
export async function handleText(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type as ChatType | undefined;
  const threadId = ctx.message?.message_thread_id;
  let message = ctx.message?.text;

  if (!userId || !message || !chatId) {
    return;
  }

  // 1. Authorization check (per-chat)
  if (!isAuthorizedForChat(userId, chatId, chatType)) {
    // Only reply in private chats to avoid spam
    if (chatType === "private") {
      await ctx.reply("Unauthorized. Contact the bot owner for access.");
    }
    return;
  }

  // 1.1. Check if bot should respond (for groups)
  const isReplyToBot = Boolean(
    ctx.message?.reply_to_message?.from?.is_bot &&
    ctx.message?.reply_to_message?.from?.username === botUsername
  );
  if (!shouldRespond(chatType, message, botUsername, isReplyToBot)) {
    return;
  }

  // 1.5. React to user message to show it's received
  try {
    await ctx.react(Reactions.READ);
  } catch (error) {
    console.debug("Failed to add reaction to user message:", error);
  }

  // Get session for this chat/thread
  const session = sessionManager.getSession(chatId, threadId);

  // 2. Check for pending direct input (before normal processing)
  if (session.pendingDirectInput) {
    const result = await handleDirectInput(
      ctx,
      session,
      chatId,
      message,
      username,
      userId
    );
    if (result.handled) return;
  }

  // 2.5. Check for parseTextChoice (fallback from keyboard failure)
  if (session.parseTextChoiceState) {
    const parseState = session.parseTextChoiceState;

    // Check expiration (5 minutes)
    if (isExpired(parseState.createdAt)) {
      session.clearParseTextChoice();
      await sendSystemMessage(ctx, "⏱️ Choice expired (5 min). Please ask again.");
      return;
    }

    // Parse number from message
    const numberMatch = message.match(/^(\d+)$/);
    if (!numberMatch) {
      await ctx.reply(
        "❓ Please reply with just the number (e.g., 1, 2, 3). Or ask again."
      );
      return;
    }

    const choiceNum = parseInt(numberMatch[1]!, 10);
    session.clearParseTextChoice();

    if (parseState.type === "single") {
      const choice = parseState.extractedChoice;
      if (!choice || choiceNum < 1 || choiceNum > choice.choices.length) {
        await ctx.reply(
          `❌ Invalid number. Please choose 1-${choice?.choices.length || 0}.`
        );
        return;
      }

      const selectedOption = choice.choices[choiceNum - 1]!;
      session.setActivityState("working");

      await sendDirectInputToClaude(
        ctx,
        session,
        selectedOption.label,
        username,
        userId,
        chatId,
        message
      );
      return;
    } else {
      // Multi-form not fully supported in text fallback yet
      // For now, treat as single-question text input
      await ctx.reply(
        "⚠️ Multi-form text fallback not yet supported. Please try again."
      );
      return;
    }
  }

  // 2. Check for interrupt prefix
  const wasInterrupt = message.startsWith("!");
  message = await checkInterrupt(message, session);
  if (!message.trim()) {
    // "!" alone - provide feedback that stop was requested
    if (wasInterrupt) {
      // Extract lost steering messages for recovery UI
      const lostMessages = session.extractSteeringMessages();

      if (lostMessages.length > 0) {
        // Show inline buttons for lost message recovery
        const sessionKey = `${chatId}${threadId ? `:${threadId}` : ""}`;
        session.setPendingRecovery(lostMessages, chatId!);

        const keyboard = TelegramChoiceBuilder.buildLostMessageKeyboard(sessionKey);
        const messageText = TelegramChoiceBuilder.buildLostMessageText(lostMessages, true);

        try {
          const sentMsg = await ctx.reply(messageText, {
            reply_markup: keyboard,
            parse_mode: "Markdown",
          });
          session.setPendingRecovery(lostMessages, chatId!, sentMsg.message_id);
        } catch (replyError) {
          console.error("[INTERRUPT] Failed to send lost message UI:", replyError);
          try {
            await sendSystemMessage(ctx, "🛑 Stopped (had undelivered messages)");
          } catch {}
        }
      } else {
        try {
          await sendSystemMessage(ctx, "🛑 Stopped");
        } catch {
          // Fallback to reaction if reply fails
          try {
            await ctx.react(Reactions.INTERRUPTED);
          } catch {}
        }
      }
    }
    return;
  }

  // Strip @mention from message if present (cleaner input for Claude)
  if (botUsername && message.includes(`@${botUsername}`)) {
    message = message.replace(new RegExp(`@${botUsername}\\s*`, "g"), "").trim();
  }

  // 2.5. Real-time steering: buffer message if Claude is currently executing
  if (session.isProcessing) {
    console.log(`[STEERING] Message gated by isProcessing=true, queryState=${session.queryState}, msg="${message.slice(0, 50)}"`);

    // Interrupt messages should never be buffered as steering, otherwise they can be cleared by
    // the prior request's stopProcessing() cleanup before being consumed.
    if (wasInterrupt) {
      const start = Date.now();
      while (session.isProcessing && Date.now() - start < 2000) {
        await Bun.sleep(50);
      }
    } else {
      const messageId = ctx.message?.message_id;

      // Structured logging context for steering operations
      const steeringContext = {
        chatId,
        userId,
        username,
        messageId,
        currentTool: session.currentTool,
        hasSteeringMessages: session.hasSteeringMessages(),
        timestamp: new Date().toISOString(),
      };

      if (messageId === undefined) {
        console.error(
          "[STEERING] CRITICAL: Missing message_id, cannot buffer steering",
          {
            ...steeringContext,
            messagePreview: message.slice(0, 100),
          }
        );
        try {
          await ctx.reply(
            "⚠️ Unable to queue message (technical issue: missing message ID). Please try sending again."
          );
        } catch (replyError) {
          console.error(
            "Failed to notify user of missing message_id:",
            replyError,
            steeringContext
          );
          // Final fallback: attempt reaction
          try {
            await ctx.react(Reactions.ERROR_SOMA);
          } catch {}
        }
        return;
      }

      const evicted = session.addSteering(
        message,
        messageId,
        session.currentTool || undefined
      );

      if (evicted) {
        console.warn("[STEERING] Buffer full, oldest message evicted", {
          ...steeringContext,
          bufferSize: 20,
        });

        let notified = false;

        // Try reply first
        try {
          await ctx.reply(
            "⚠️ **Message Queue Full**\n\nYour oldest queued message was dropped because Claude is very busy. Please wait for current task to complete."
          );
          notified = true;
        } catch (replyError) {
          console.error("Failed to notify via reply:", replyError, steeringContext);

          // Fallback to reaction - eviction means message was received but dropped
          try {
            await ctx.react(Reactions.CANCELLED);
            notified = true;
          } catch (reactError) {
            console.error(
              "Failed to notify via reaction:",
              reactError,
              steeringContext
            );
          }
        }

        if (!notified) {
          console.error(
            "[STEERING] CRITICAL: Could not notify user of message eviction",
            steeringContext
          );
        }
      } else {
        console.log(
          "[STEERING] Buffered user message during execution",
          steeringContext
        );
        try {
          await ctx.react(Reactions.STEERING_BUFFERED);
        } catch (error) {
          console.debug("Failed to add steering reaction:", error, steeringContext);
        }
      }
      return;
    }
  }

  // 3. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await sendSystemMessage(ctx, `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`);
    return;
  }

  // 3.5. Handle pending recovery race condition
  // If user sends a new message while recovery UI is displayed, auto-resolve as context
  if (session.hasPendingRecovery()) {
    const recovery = session.getPendingRecovery();
    if (recovery) {
      console.log(`[RECOVERY] Auto-resolving pending recovery (${recovery.messages.length} messages) as context for new message`);

      // Format lost messages as context
      const resolved = session.resolvePendingRecovery();
      if (resolved && resolved.length > 0) {
        const formattedContext = resolved
          .map((m) => {
            const ts = new Date(m.timestamp).toLocaleTimeString("en-US", {
              hour12: false,
            });
            return `[${ts}] ${m.content}`;
          })
          .join("\n");
        session.nextQueryContext = `[CONTEXT FROM INTERRUPTED SESSION - ${resolved.length} message(s)]\n${formattedContext}\n[END CONTEXT]`;
      }

      // Try to delete the inline button message
      if (recovery.messageId) {
        try {
          await ctx.api.deleteMessage(chatId!, recovery.messageId);
        } catch (deleteError) {
          console.debug("[RECOVERY] Failed to delete inline button message:", deleteError);
        }
      }

      // Brief notification
      try {
        await sendSystemMessage(ctx, "📋 Previous messages added as context.");
      } catch {}
    }
  }

  // 4. Store message for retry
  session.lastMessage = message;

  // 4.5. Add timestamp to message
  const messageWithTimestamp = addTimestamp(message);

  // 5. Mark processing started
  const stopProcessing = session.startProcessing();

  // 5.5. Update reaction to show processing
  try {
    await ctx.react(Reactions.PROCESSING);
  } catch {
    // Ignore reaction errors
  }

  // 6. Start typing indicator
  const typing = startTypingIndicator(ctx);

  // 7. Create streaming state and callback
  let state = new StreamingState();
  let statusCallback = await createStatusCallback(ctx, state, session);

  // 8. Send to Claude with retry logic for crashes
  const MAX_RETRIES = 1;

  try {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await session.sendMessageStreaming(
        messageWithTimestamp,
        username,
        userId,
        statusCallback,
        chatId,
        ctx
      );

      // 9. Audit log
      await auditLog(userId, username, "TEXT", message, response);

      // 9.0.3 Update reaction to show complete
      try {
        await ctx.react(Reactions.COMPLETE);
      } catch {
        // Ignore reaction errors
      }

      // 9.0.5 Auto-continue loop: drain ALL pending steering messages
      // Messages can arrive during follow-up queries, so loop until empty (max 5 rounds)
      const MAX_AUTO_CONTINUE_ROUNDS = 5;
      let autoContinueRound = 0;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        // Restore any messages injected via postToolUseHook back to buffer
        const bufferBeforeRestore = session.getSteeringCount();
        const restoredCount = session.restoreInjectedSteering();
        const bufferAfterRestore = session.getSteeringCount();
        console.log(
          `[STEERING DEBUG] Round ${autoContinueRound}: Before restore: ${bufferBeforeRestore}, Restored: ${restoredCount}, After: ${bufferAfterRestore}`
        );

        const hasSteering = session.hasSteeringMessages();
        console.log(`[AUTO-CONTINUE] Round ${autoContinueRound}: hasSteeringMessages() = ${hasSteering}, buffer count = ${session.getSteeringCount()}`);

        if (!hasSteering) {
          if (autoContinueRound === 0) {
            console.log(`[AUTO-CONTINUE] No pending steering messages`);
          } else {
            console.log(`[AUTO-CONTINUE] Drained all steering after ${autoContinueRound} round(s)`);
          }
          break;
        }

        if (autoContinueRound >= MAX_AUTO_CONTINUE_ROUNDS) {
          console.warn(`[AUTO-CONTINUE] Hit max rounds (${MAX_AUTO_CONTINUE_ROUNDS}), stopping. Remaining buffer: ${session.getSteeringCount()}`);
          break;
        }

        autoContinueRound++;
        const steeringCount = session.getSteeringCount();
        console.log(`[AUTO-CONTINUE] Round ${autoContinueRound}: Processing ${steeringCount} pending message(s)`);

        const steeringContent = session.consumeSteering();
        console.log(`[AUTO-CONTINUE] Round ${autoContinueRound}: Consumed: "${steeringContent?.slice(0, 100)}..."`);

        if (steeringContent) {
          try {
            await sendSystemMessage(ctx, `💬 <i>대기 메시지 ${steeringCount}개 처리 중...</i>`, {
              parse_mode: "HTML",
            });
          } catch {
            // Notification failed, continue anyway
          }

          const followUpMessage = `[이전 응답 중 보낸 메시지 - 지금 처리합니다]\n${steeringContent}`;

          const followUpState = new StreamingState();
          const followUpCallback = await createStatusCallback(
            ctx,
            followUpState,
            session
          );

          try {
            console.log(`[AUTO-CONTINUE] Round ${autoContinueRound}: Sending follow-up query...`);
            const followUpResponse = await session.sendMessageStreaming(
              followUpMessage,
              username,
              userId,
              followUpCallback,
              chatId,
              ctx
            );
            console.log(`[AUTO-CONTINUE] Round ${autoContinueRound}: Follow-up complete, response length: ${followUpResponse.length}`);
            await auditLog(
              userId,
              username,
              "STEERING_FOLLOWUP",
              steeringContent,
              followUpResponse
            );
            // Settle delay: let in-flight messages arrive before checking buffer again
            await Bun.sleep(500);
          } catch (followUpError) {
            console.error(`[AUTO-CONTINUE] Round ${autoContinueRound}: Follow-up FAILED:`, followUpError);
            await sendSystemMessage(ctx, "⚠️ 대기 중인 메시지 처리 실패. 다시 보내주세요.");
            break;
          }
        } else {
          console.warn(`[AUTO-CONTINUE] consumeSteering returned null/empty despite hasSteering=true`);
          break;
        }
      }

      // 9.5. Check context limit and trigger auto-save
      if (session.needsSave) {
        const currentTokens = session.currentContextTokens;
        const percentage = ((currentTokens / 200_000) * 100).toFixed(1);
        await sendSystemMessage(ctx,
          `⚠️ **Context Limit Approaching**\n\n` +
            `Current: ${currentTokens.toLocaleString()} / 200,000 tokens (${percentage}%)\n\n` +
            `Initiating automatic save...`,
          { parse_mode: "Markdown" }
        );

        // Auto-trigger /save skill
        try {
          const saveResponse = await session.sendMessageStreaming(
            "Context limit reached. Execute: Skill tool with skill='oh-my-claude:save'",
            username,
            userId,
            async () => {}, // No streaming updates for auto-save
            chatId,
            ctx
          );

          // Parse save_id from response
          const saveIdMatch = saveResponse.match(
            /Saved to:.*?\/docs\/tasks\/save\/(\d{8}_\d{6})\//
          );
          if (saveIdMatch && saveIdMatch[1]) {
            const saveId = saveIdMatch[1];

            // C1 FIX: Validate save ID format
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

            // C2 FIX: Verify write succeeded
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

            // ORACLE: Add telemetry
            console.log("[TELEMETRY] auto_save_success", {
              saveId,
              contextTokens: currentTokens,
              timestamp: new Date().toISOString(),
            });

            await sendSystemMessage(ctx,
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
          // S3 FIX: Critical error handling - prevent data loss
          console.error("CRITICAL: Auto-save failed:", error);
          console.error("Stack:", error instanceof Error ? error.stack : "N/A");

          // S2 FIX: Sanitize error message
          const errorStr = String(error);
          const sanitized = errorStr.replace(
            process.env.HOME || "/home/zhugehyuk",
            "~"
          );

          await sendSystemMessage(ctx,
            `🚨 **CRITICAL: Auto-Save Failed**\n\n` +
              `Error: ${sanitized.slice(0, 300)}\n\n` +
              `⚠️ **YOUR WORK IS NOT SAVED**\n\n` +
              `Do NOT restart. Try manual: /oh-my-claude:save`,
            { parse_mode: "Markdown" }
          );
        }
      }

      break; // Success - exit retry loop
    } catch (error) {
      const errorStr = String(error);
      const isClaudeCodeCrash = errorStr.includes("exited with code");

      cleanupToolMessages(ctx, state.toolMessages);

      // Retry on Claude Code crash (not user cancellation)
      // Common cause: stale session ID from previous run
      if (isClaudeCodeCrash && attempt < MAX_RETRIES) {
        console.log(
          `Session expired or crashed, reconnecting (attempt ${attempt + 2}/${MAX_RETRIES + 1})...`
        );
        await session.kill(); // Clear corrupted session
        await sendSystemMessage(ctx, `⚠️ Session expired, reconnecting...`);
        // Clean up old state before retry
        state.cleanup();
        // Reset state for retry
        state = new StreamingState();
        statusCallback = await createStatusCallback(ctx, state, session);
        continue;
      }

      // RL-4: Rate limit detection + auto-fallback
      const rateLimitInfo = isRateLimitError(error);
      if (rateLimitInfo.isRateLimit) {
        console.log(`[RATE-LIMIT] Detected: bucket=${rateLimitInfo.bucket}`);
        session.rateLimitState.consecutiveFailures++;

        const usage = await fetchClaudeUsage(10);
        const richMessage = await formatRateLimitForUser(error, usage);

        // Check cooldown
        if (
          session.rateLimitState.cooldownUntil &&
          Date.now() < session.rateLimitState.cooldownUntil
        ) {
          await ctx.reply(richMessage + "\n\n🛑 연속 실패로 대기 중. 잠시 후 다시 시도해주세요.");
          break;
        }

        // Cap at 3 consecutive failures
        if (session.rateLimitState.consecutiveFailures >= 3) {
          session.rateLimitState.cooldownUntil = Date.now() + 5 * 60 * 1000;
          await ctx.reply(richMessage + "\n\n🛑 연속 3회 실패. 5분 후 다시 시도해주세요.");
          break;
        }

        // Try Sonnet fallback (only if not already on Sonnet)
        if (!session.temporaryModelOverride && usage && isSonnetAvailable(usage)) {
          const sonnetModel = "claude-sonnet-4-5-20250929" as const;
          session.temporaryModelOverride = sonnetModel;

          // Store Opus reset time for recovery
          if (usage.five_hour?.resets_at) {
            session.rateLimitState.opusResetsAt = usage.five_hour.resets_at;
          }

          const sonnetPct = usage.seven_day_sonnet
            ? `${Math.round(usage.seven_day_sonnet.utilization * 100)}%`
            : "?";

          await sendSystemMessage(ctx,
            richMessage +
            `\n\n💡 Sonnet 사용량 ${sonnetPct} → 자동 전환합니다.` +
            `\n🔄 메시지 재전송 중...`
          );

          // Retry with Sonnet - reset state
          state.cleanup();
          state = new StreamingState();
          statusCallback = await createStatusCallback(ctx, state, session);

          try {
            const retryResponse = await session.sendMessageStreaming(
              messageWithTimestamp,
              username,
              userId,
              statusCallback,
              chatId,
              ctx
            );
            await auditLog(userId, username, "TEXT_FALLBACK", message, retryResponse);
            try { await ctx.react(Reactions.COMPLETE); } catch {}

            const fallbackModel = session.temporaryModelOverride;
            const modelName = fallbackModel ? MODEL_DISPLAY_NAMES[fallbackModel] || fallbackModel : "Sonnet";
            await sendSystemMessage(ctx,
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
              const retryMessage = await formatRateLimitForUser(retryError, retryUsage);
              await ctx.reply(retryMessage + "\n\n🛑 Sonnet도 한도 초과. 잠시 후 다시 시도해주세요.");
            } else {
              await ctx.reply(formatErrorForUser(retryError));
            }
            break;
          }
        } else {
          // No Sonnet fallback available
          await ctx.reply(richMessage);
          break;
        }
      }

      // Final attempt failed or non-retryable error
      console.error(formatErrorForLog(error));

      // Clear steering buffer on error to prevent wrong context delivery
      if (session.hasSteeringMessages()) {
        const lostCount = session.getSteeringCount();
        session.consumeSteering(); // Clear the buffer
        console.warn(`[STEERING] Cleared ${lostCount} message(s) due to error`);
        await ctx.reply(
          `⚠️ 에러로 인해 대기 중이던 ${lostCount}개 메시지가 처리되지 않았습니다. 다시 보내주세요.`
        );
      }

      // Check if it was a cancellation
      if (await handleAbortError(ctx, error, session)) {
        // Abort handled (reaction added by handleAbortError)
      } else {
        // Add error reaction for model/other errors
        try {
          await ctx.react(Reactions.ERROR_MODEL);
        } catch {
          // Ignore reaction errors
        }
        await ctx.reply(formatErrorForUser(error));
      }
      break; // Exit loop after handling error
    }
  }
  } finally {
    // 10. Cleanup - ALWAYS runs even if early return/throw
    state.cleanup();
    stopProcessing();
    typing.stop();
  }
}
