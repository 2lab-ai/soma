/**
 * Text message handler for Claude Telegram Bot.
 */

import type { Context } from "grammy";
import { sessionManager } from "../session-manager";
import { WORKING_DIR } from "../config";
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
import { handleAbortError } from "../utils/error-classification";
import type { ClaudeSession } from "../session";

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
    await ctx.reply("⏱️ Direct input expired (5 min). Please ask again.");
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
    await ctx.reply("⚠️ Form expired. Please ask again.");
    return { complete: false, selectedLabel: "" };
  }

  const choices = session.choiceState.extractedChoices;
  if (!choices) {
    await ctx.reply("⚠️ Form data not found.");
    return { complete: false, selectedLabel: "" };
  }

  const question = choices.questions.find((q) => q.id === directInput.questionId);
  if (!question) {
    await ctx.reply("⚠️ Invalid question ID.");
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
    await ctx.reply(`⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`);
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
    // Log full error for debugging
    console.error("Error processing direct input:", error);
    console.error("Stack:", error instanceof Error ? error.stack : "N/A");

    // Reset activity state on error
    session.setActivityState("idle");

    await cleanupToolMessages(ctx, state.toolMessages);

    if (!(await handleAbortError(ctx, error, session))) {
      const errorStr = String(error);
      await ctx.reply(`❌ Error: ${errorStr.slice(0, 300)}`);
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
    await ctx.react("👀");
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
      await ctx.reply("⏱️ Choice expired (5 min). Please ask again.");
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
      await ctx.reply("⚠️ Multi-form text fallback not yet supported. Please try again.");
      return;
    }
  }

  // 2. Check for interrupt prefix
  const wasInterrupt = message.startsWith("!");
  message = await checkInterrupt(message);
  if (!message.trim()) {
    return;
  }

  // Strip @mention from message if present (cleaner input for Claude)
  if (botUsername && message.includes(`@${botUsername}`)) {
    message = message.replace(new RegExp(`@${botUsername}\\s*`, "g"), "").trim();
  }

  // 2.5. Real-time steering: buffer message if Claude is currently executing
  if (session.isProcessing) {
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
        timestamp: new Date().toISOString()
      };

      if (messageId === undefined) {
        console.error("[STEERING] CRITICAL: Missing message_id, cannot buffer steering", {
          ...steeringContext,
          messagePreview: message.slice(0, 100)
        });
        try {
          await ctx.reply("⚠️ Unable to queue message (technical issue: missing message ID). Please try sending again.");
        } catch (replyError) {
          console.error("Failed to notify user of missing message_id:", replyError, steeringContext);
          // Final fallback: attempt reaction
          try {
            await ctx.react("❌");
          } catch {}
        }
        return;
      }

      const evicted = session.addSteering(message, messageId, session.currentTool || undefined);

      if (evicted) {
        console.warn("[STEERING] Buffer full, oldest message evicted", {
          ...steeringContext,
          bufferSize: 20
        });

        let notified = false;

        // Try reply first
        try {
          await ctx.reply("⚠️ **Message Queue Full**\n\nYour oldest queued message was dropped because Claude is very busy. Please wait for current task to complete.");
          notified = true;
        } catch (replyError) {
          console.error("Failed to notify via reply:", replyError, steeringContext);

          // Fallback to reaction (use valid Telegram emoji)
          try {
            await ctx.react("🤔");
            notified = true;
          } catch (reactError) {
            console.error("Failed to notify via reaction:", reactError, steeringContext);
          }
        }

        if (!notified) {
          console.error("[STEERING] CRITICAL: Could not notify user of message eviction", steeringContext);
        }
      } else {
        console.log("[STEERING] Buffered user message during execution", steeringContext);
        try {
          await ctx.react("👌");
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
    await ctx.reply(`⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`);
    return;
  }

  // 4. Store message for retry
  session.lastMessage = message;

  // 4.5. Add timestamp to message
  const messageWithTimestamp = addTimestamp(message);

  // 5. Mark processing started
  const stopProcessing = session.startProcessing();

  // 6. Start typing indicator
  const typing = startTypingIndicator(ctx);

  // 7. Create streaming state and callback
  let state = new StreamingState();
  let statusCallback = await createStatusCallback(ctx, state, session);

  // 8. Send to Claude with retry logic for crashes
  const MAX_RETRIES = 1;

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

      // 9.5. Check context limit and trigger auto-save
      if (session.needsSave) {
        const currentTokens = session.currentContextTokens;
        const percentage = ((currentTokens / 200_000) * 100).toFixed(1);
        await ctx.reply(
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
              return;
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

            await ctx.reply(
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

          await ctx.reply(
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

      await cleanupToolMessages(ctx, state.toolMessages);

      // Retry on Claude Code crash (not user cancellation)
      // Common cause: stale session ID from previous run
      if (isClaudeCodeCrash && attempt < MAX_RETRIES) {
        console.log(
          `Session expired or crashed, reconnecting (attempt ${attempt + 2}/${MAX_RETRIES + 1})...`
        );
        await session.kill(); // Clear corrupted session
        await ctx.reply(`⚠️ Session expired, reconnecting...`);
        // Clean up old state before retry
        state.cleanup();
        // Reset state for retry
        state = new StreamingState();
        statusCallback = await createStatusCallback(ctx, state, session);
        continue;
      }

      // Final attempt failed or non-retryable error
      console.error("Error processing message:", error);

      // Check if it was a cancellation
      if (await handleAbortError(ctx, error, session)) {
        // Abort handled
      } else {
        await ctx.reply(`❌ Error: ${errorStr.slice(0, 200)}`);
      }
      break; // Exit loop after handling error
    }
  }

  // 10. Cleanup
  state.cleanup();
  stopProcessing();
  typing.stop();
}
