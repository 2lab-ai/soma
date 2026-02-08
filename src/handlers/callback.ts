import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { unlinkSync } from "fs";
import { sessionManager } from "../session-manager";
import type { ClaudeSession } from "../session";
import { type ChatType, isAuthorizedForChat } from "../security";
import { auditLog, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback, cleanupToolMessages } from "./streaming";
import { TelegramChoiceBuilder } from "../utils/telegram-choice-builder";
import { isAbortError } from "../utils/error-classification";
import { sendSystemMessage } from "../utils/system-message";
import {
  applyChoiceSelection,
  ChoiceTransitionError,
  createPendingDirectInput,
} from "../core/session/choice-flow";
import {
  getCurrentConfig,
  updateContextModel,
  MODEL_DISPLAY_NAMES,
  AVAILABLE_MODELS,
  REASONING_TOKENS,
  type ConfigContext,
  type ModelId,
  type ReasoningLevel,
} from "../model-config";
import { skillsRegistry } from "../services/skills-registry";
import { ChatSearchService } from "../services/chat-search-service";
import { FileChatStorage } from "../storage/chat-storage";
import { CHAT_HISTORY_DATA_DIR, CHAT_HISTORY_ENABLED } from "../config";

type CallbackMessage = {
  message_id?: number;
  message_thread_id?: number;
};

const ERROR_PATTERNS: [RegExp, string][] = [
  [
    /network|fetch|timeout|econnrefused/i,
    "⚠️ Network issue detected. Please try again.",
  ],
  [
    /rate.?limit|429|too many/i,
    "⏳ Too many requests. Please wait a moment and try again.",
  ],
  [
    /permission|403|forbidden/i,
    "🔒 Permission error. Bot may need additional permissions.",
  ],
  [/not found|404/i, "🔍 Resource not found. Please try a different action."],
  [/etimedout|dns|enotfound/i, "🌐 DNS/connection timeout. Check internet connection."],
  [/50[0-3]/i, "🔧 Server error. Service may be temporarily unavailable."],
  [/epipe|econnreset/i, "⚠️ Connection reset. Please try again."],
];

function getErrorGuidance(errorStr: string): string {
  for (const [pattern, message] of ERROR_PATTERNS) {
    if (pattern.test(errorStr)) return message;
  }
  return "ℹ️ An unexpected error occurred. Please try again or contact support.";
}

function getCallbackMessage(ctx: Context): CallbackMessage | undefined {
  return ctx.callbackQuery?.message as CallbackMessage | undefined;
}

async function removeKeyboardSilently(ctx: Context, context: string): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
  } catch (error) {
    console.warn(
      `Failed to remove keyboard (${context}, messageId: ${getCallbackMessage(ctx)?.message_id}):`,
      error
    );
  }
}

async function sendMessageToClaude(
  ctx: Context,
  session: ClaudeSession,
  message: string,
  userId: number,
  username: string,
  chatId: number,
  auditAction: string
): Promise<void> {
  if (session.isRunning) {
    console.log("Interrupting current query for button response");
    await session.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const typing = startTypingIndicator(ctx);
  const state = new StreamingState();
  const statusCallback = await createStatusCallback(ctx, state, session);

  try {
    const response = await session.sendMessageStreaming(
      message,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );
    await auditLog(userId, username, auditAction, message, response);
  } catch (error) {
    console.error(`Error processing ${auditAction.toLowerCase()}:`, error);
    cleanupToolMessages(ctx, state.toolMessages);

    if (isAbortError(error)) {
      const wasInterrupt = session.consumeInterruptFlag();
      if (!wasInterrupt) {
        await sendSystemMessage(ctx, "🛑 Query stopped.");
      }
    } else {
      const errorStr = String(error);
      const guidance = getErrorGuidance(errorStr);
      await ctx.reply(`❌ Error: ${errorStr.slice(0, 200)}\n\n${guidance}`);
    }
  } finally {
    state.cleanup();
    typing.stop();
  }
}

async function handleChoiceCallback(
  ctx: Context,
  callbackData: string,
  chatId: number,
  threadId: number | undefined,
  userId: number,
  username: string
): Promise<void> {
  const parts = callbackData.split(":");
  // Format: c:{compressedKey}:{optId} OR c:{compressedKey}:{qId}:{optId}

  if (parts.length < 3 || parts.length > 4) {
    await ctx.answerCallbackQuery({ text: "Invalid callback format" });
    return;
  }

  const compressedKey = parts[1]!;
  const session = sessionManager.getSession(chatId, threadId);

  // Validate session key matches
  const sessionKey = `${chatId}${threadId ? `:${threadId}` : ""}`;
  const expectedKey = TelegramChoiceBuilder.compressSessionKey(sessionKey);

  if (compressedKey !== expectedKey) {
    await ctx.answerCallbackQuery({
      text: "Selection expired. Please ask again.",
    });
    await removeKeyboardSilently(ctx, "expired session");
    return;
  }

  if (!session.choiceState) {
    await ctx.answerCallbackQuery({
      text: "Session expired. Type your choice directly.",
    });
    await removeKeyboardSilently(ctx, "no choiceState");
    return;
  }

  // Validate callback is for current choice message
  const callbackMessageId = getCallbackMessage(ctx)?.message_id;
  const isMessageMismatch =
    callbackMessageId && !session.choiceState.messageIds.includes(callbackMessageId);

  if (isMessageMismatch) {
    await ctx.answerCallbackQuery({ text: "This choice is outdated." });
    await removeKeyboardSilently(ctx, "outdated choice");
    return;
  }

  // Handle direct input
  const lastPart = parts[parts.length - 1]!;
  if (lastPart === "__direct") {
    const questionId = parts.length === 4 ? parts[2] : undefined;
    if (!callbackMessageId) {
      await ctx.answerCallbackQuery({ text: "Invalid callback message" });
      return;
    }
    session.pendingDirectInput = createPendingDirectInput(
      session.choiceState,
      callbackMessageId,
      Date.now(),
      questionId
    );
    await ctx.answerCallbackQuery({ text: "Type your answer:" });
    await ctx.editMessageText("✏️ Waiting for your input...");
    return;
  }

  let selectedLabel: string;
  try {
    if (session.choiceState.type === "single") {
      const transition = applyChoiceSelection(session.choiceState, {
        mode: "single_option",
        optionId: parts[2]!,
      });
      selectedLabel = transition.selectedLabel;
    } else {
      if (parts.length !== 4) {
        await ctx.answerCallbackQuery({ text: "Invalid multi-form callback" });
        return;
      }

      const transition = applyChoiceSelection(session.choiceState, {
        mode: "multi_option",
        questionId: parts[2]!,
        optionId: parts[3]!,
      });

      if (transition.status === "pending") {
        session.choiceState = transition.nextChoiceState;
        await ctx.editMessageText(`${transition.questionText}\n\n✓ ${transition.selectedLabel}`);
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        await ctx.answerCallbackQuery({
          text: `Selected: ${transition.selectedLabel.slice(0, 50)}`,
        });
        return;
      }

      selectedLabel = transition.selectedLabel;
    }
  } catch (error) {
    if (error instanceof ChoiceTransitionError) {
      await ctx.answerCallbackQuery({ text: "Choice is invalid or expired" });
      return;
    }
    throw error;
  }

  // Clear choice state
  session.clearChoiceState();
  session.setActivityState("working");

  try {
    await ctx.editMessageText(`✓ ${selectedLabel}`);
  } catch (error) {
    console.warn(
      `Failed to update choice message (messageId: ${getCallbackMessage(ctx)?.message_id}):`,
      error
    );
  }

  await ctx.answerCallbackQuery({
    text: `Selected: ${selectedLabel.slice(0, 50)}`,
  });

  await sendMessageToClaude(
    ctx,
    session,
    selectedLabel,
    userId,
    username,
    chatId,
    "CHOICE_CALLBACK"
  );
}

/**
 * Handle model configuration callbacks
 * Format: model:context:general | model:model:general:opus | model:reasoning:general:high | model:save:general:opus:high
 */
async function handleModelCallback(ctx: Context, callbackData: string): Promise<void> {
  try {
    const parts = callbackData.split(":");
    const action = parts[1];

    if (action === "context") {
      // Context selection - show model selection
      const context = parts[2] as ConfigContext;
      const config = getCurrentConfig();
      const currentModel = config.contexts[context]?.model || config.defaults.model;

      const keyboard = new InlineKeyboard();
      for (const modelId of AVAILABLE_MODELS) {
        const displayName = MODEL_DISPLAY_NAMES[modelId];
        const current = modelId === currentModel ? " ✓" : "";
        keyboard
          .text(
            `${displayName}${current}`,
            `model:model:${context}:${modelId.split("-")[1]}`
          )
          .row();
      }
      keyboard.text("« Back", "model:back");

      await ctx.editMessageText(
        `🤖 <b>Select Model for ${context.charAt(0).toUpperCase() + context.slice(1)}</b>\n\n` +
          `Current: ${MODEL_DISPLAY_NAMES[currentModel]}`,
        {
          parse_mode: "HTML",
          reply_markup: keyboard,
        }
      );
    } else if (action === "model") {
      // Model selection - show reasoning selection
      const context = parts[2] as ConfigContext;
      const modelShort = parts[3] || ""; // "opus", "sonnet", "haiku"
      const modelId = AVAILABLE_MODELS.find((m) => m.includes(modelShort))!;
      const config = getCurrentConfig();
      const currentReasoning =
        config.contexts[context]?.reasoning || config.defaults.reasoning;

      const keyboard = new InlineKeyboard();
      const reasoningLevels: ReasoningLevel[] = [
        "none",
        "minimal",
        "medium",
        "high",
        "xhigh",
      ];
      for (const level of reasoningLevels) {
        const tokens = REASONING_TOKENS[level];
        const current = level === currentReasoning ? " ✓" : "";
        const display =
          level === "xhigh" ? "X-High" : level.charAt(0).toUpperCase() + level.slice(1);
        keyboard
          .text(
            `${display} (${tokens.toLocaleString()} tokens)${current}`,
            `model:save:${context}:${modelShort}:${level}`
          )
          .row();
      }
      keyboard.text("« Back", `model:context:${context}`);

      await ctx.editMessageText(
        `🧠 <b>Select Reasoning Budget</b>\n\n` +
          `Model: ${MODEL_DISPLAY_NAMES[modelId]}\n` +
          `Context: ${context.charAt(0).toUpperCase() + context.slice(1)}`,
        {
          parse_mode: "HTML",
          reply_markup: keyboard,
        }
      );
    } else if (action === "save") {
      // Save configuration
      const context = parts[2] as ConfigContext;
      const modelShort = parts[3] || "";
      const reasoning = parts[4] as ReasoningLevel;
      const modelId = AVAILABLE_MODELS.find((m) => m.includes(modelShort))!;

      await updateContextModel(context, modelId, reasoning);

      await ctx.editMessageText(
        `✅ <b>Configuration Saved!</b>\n\n` +
          `<b>${context.charAt(0).toUpperCase() + context.slice(1)}</b> now uses:\n` +
          `Model: ${MODEL_DISPLAY_NAMES[modelId]}\n` +
          `Reasoning: ${reasoning} (${REASONING_TOKENS[reasoning].toLocaleString()} tokens)\n\n` +
          `Use /model to configure other contexts.`,
        { parse_mode: "HTML" }
      );
    } else if (action === "back") {
      // Back to main menu - call handleModel equivalent
      const config = getCurrentConfig();
      const keyboard = new InlineKeyboard()
        .text("💬 Chat Model", "model:context:general")
        .row()
        .text("📝 Summary Model", "model:context:summary")
        .row()
        .text("⏰ Cron Model", "model:context:cron");

      const generalModel = config.contexts.general?.model || config.defaults.model;
      const generalReasoning =
        config.contexts.general?.reasoning || config.defaults.reasoning;
      const summaryModel = config.contexts.summary?.model || config.defaults.model;
      const summaryReasoning =
        config.contexts.summary?.reasoning || config.defaults.reasoning;
      const cronModel = config.contexts.cron?.model || config.defaults.model;
      const cronReasoning =
        config.contexts.cron?.reasoning || config.defaults.reasoning;

      await ctx.editMessageText(
        `🤖 <b>Model Configuration</b>\n\n` +
          `<b>Current Settings:</b>\n\n` +
          `💬 <b>Chat:</b> ${MODEL_DISPLAY_NAMES[generalModel]} (${generalReasoning}, ${REASONING_TOKENS[generalReasoning]} tokens)\n` +
          `📝 <b>Summary:</b> ${MODEL_DISPLAY_NAMES[summaryModel]} (${summaryReasoning}, ${REASONING_TOKENS[summaryReasoning]} tokens)\n` +
          `⏰ <b>Cron:</b> ${MODEL_DISPLAY_NAMES[cronModel]} (${cronReasoning}, ${REASONING_TOKENS[cronReasoning]} tokens)\n\n` +
          `Select which context to configure:`,
        {
          parse_mode: "HTML",
          reply_markup: keyboard,
        }
      );
    }

    await ctx.answerCallbackQuery();
  } catch (error) {
    console.error("[ERROR:MODEL_CALLBACK_FAILED]", error);
    await ctx.answerCallbackQuery({ text: "❌ Failed to update configuration" });
  }
}

async function handleSkillCallback(
  ctx: Context,
  skillId: string,
  userId: number,
  username: string,
  chatId: number,
  threadId: number | undefined
): Promise<void> {
  if (skillId === "manage") {
    await ctx.editMessageText(
      `⚙️ <b>Skills Management</b>\n\n` +
        `To customize your skills menu:\n\n` +
        `• <b>Add:</b> "add do-work to skills menu"\n` +
        `• <b>Remove:</b> "remove new-task from skills menu"\n` +
        `• <b>Reset:</b> "reset skills menu to defaults"\n\n` +
        `<i>Available skills are in ~/.claude/skills/</i>`,
      { parse_mode: "HTML" }
    );
    await ctx.answerCallbackQuery();
    return;
  }

  const skills = await skillsRegistry.sync();
  if (!skills.includes(skillId)) {
    await ctx.answerCallbackQuery({
      text: `❌ Skill '${skillId}' not found`,
      show_alert: true,
    });
    return;
  }

  await ctx.answerCallbackQuery({ text: `Launching ${skillId}...` });

  try {
    await ctx.editMessageText(`🚀 Launching skill: <b>${skillId}</b>`, {
      parse_mode: "HTML",
    });
  } catch {}

  const session = sessionManager.getSession(chatId, threadId);
  const message = `/${skillId}`;

  await sendMessageToClaude(
    ctx,
    session,
    message,
    userId,
    username,
    chatId,
    "SKILL_CALLBACK"
  );
}

export async function handleCallback(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type as ChatType | undefined;
  const threadId = getCallbackMessage(ctx)?.message_thread_id;
  const callbackData = ctx.callbackQuery?.data;

  if (!userId || !chatId || !callbackData) {
    await ctx.answerCallbackQuery();
    return;
  }

  if (!isAuthorizedForChat(userId, chatId, chatType)) {
    await ctx.answerCallbackQuery({ text: "Unauthorized" });
    return;
  }

  if (callbackData.startsWith("c:")) {
    await handleChoiceCallback(ctx, callbackData, chatId, threadId, userId, username);
    return;
  }

  if (callbackData.startsWith("model:")) {
    await handleModelCallback(ctx, callbackData);
    return;
  }

  if (callbackData.startsWith("sk:")) {
    await handleSkillCallback(
      ctx,
      callbackData.slice(3),
      userId,
      username,
      chatId,
      threadId
    );
    return;
  }

  if (callbackData.startsWith("lost:")) {
    await handleLostMessageCallback(ctx, callbackData, chatId, threadId, userId, username);
    return;
  }

  // Unknown callback format
  await ctx.answerCallbackQuery();
}

/**
 * Handle lost message recovery callbacks
 * Format: lost:{compressedKey}:{action}
 * Actions: resend | discard | context
 */
async function handleLostMessageCallback(
  ctx: Context,
  callbackData: string,
  chatId: number,
  threadId: number | undefined,
  userId: number,
  username: string
): Promise<void> {
  const parts = callbackData.split(":");
  if (parts.length !== 3) {
    await ctx.answerCallbackQuery({ text: "Invalid callback format" });
    return;
  }

  const [, compressedKey, action] = parts;
  const session = sessionManager.getSession(chatId, threadId);

  // Validate session key matches
  const sessionKey = `${chatId}${threadId ? `:${threadId}` : ""}`;
  const expectedKey = TelegramChoiceBuilder.compressSessionKey(sessionKey);

  if (compressedKey !== expectedKey) {
    await ctx.answerCallbackQuery({
      text: "Session changed. Please try again.",
    });
    await removeKeyboardSilently(ctx, "mismatched session");
    return;
  }

  // Check for pending recovery
  const recovery = session.getPendingRecovery();
  if (!recovery) {
    await ctx.answerCallbackQuery({
      text: "Recovery expired or already handled.",
    });
    await removeKeyboardSilently(ctx, "no pending recovery");
    return;
  }

  const messages = recovery.messages;
  const messageCount = messages.length;

  switch (action) {
    case "resend": {
      // Get messages and add them to steering buffer for next processing
      const resolved = session.resolvePendingRecovery();
      if (resolved) {
        // Add messages as steering (they'll be sent with next query)
        for (const msg of resolved) {
          session.addSteering(msg.content, msg.messageId, "recovered");
        }
      }
      await ctx.editMessageText(
        `📨 ${messageCount}개 메시지가 다시 전송됩니다.\n\n다음 메시지를 보내면 함께 처리됩니다.`
      );
      await ctx.answerCallbackQuery({ text: "Messages queued for resend" });
      break;
    }

    case "discard": {
      session.clearPendingRecovery();
      await ctx.editMessageText(`🗑️ ${messageCount}개 메시지가 삭제되었습니다.`);
      await ctx.answerCallbackQuery({ text: "Messages discarded" });
      break;
    }

    case "context": {
      // Store messages as context for next query
      const resolved = session.resolvePendingRecovery();
      if (resolved) {
        const formattedContext = resolved
          .map((msg) => {
            const time = new Date(msg.timestamp).toLocaleTimeString("en-US", {
              hour12: false,
            });
            return `[${time}] ${msg.content}`;
          })
          .join("\n");

        session.nextQueryContext = `[CONTEXT FROM PREVIOUS SESSION - 이전 세션에서 전달되지 않은 메시지입니다. 참고용으로 포함되었습니다.]\n${formattedContext}\n[END CONTEXT]`;
      }
      await ctx.editMessageText(
        `📋 ${messageCount}개 메시지가 다음 대화의 참고 컨텍스트로 저장되었습니다.`
      );
      await ctx.answerCallbackQuery({ text: "Messages saved as context" });
      break;
    }

    case "history": {
      // Store messages + recent chat history as context for next query
      const resolved = session.resolvePendingRecovery();
      let contextParts: string[] = [];

      // Format lost messages
      if (resolved && resolved.length > 0) {
        const formattedLost = resolved
          .map((msg) => {
            const time = new Date(msg.timestamp).toLocaleTimeString("en-US", {
              hour12: false,
            });
            return `[${time}] ${msg.content}`;
          })
          .join("\n");
        contextParts.push(`[UNDELIVERED MESSAGES (${resolved.length})]\n${formattedLost}`);
      }

      // Fetch recent chat history if enabled
      if (CHAT_HISTORY_ENABLED) {
        try {
          const storage = new FileChatStorage(CHAT_HISTORY_DATA_DIR);
          const searchService = new ChatSearchService(storage);
          const recentMessages = await searchService.getMostRecent(10);

          if (recentMessages.length > 0) {
            const formattedHistory = recentMessages
              .map((record) => {
                const time = new Date(record.timestamp).toLocaleTimeString("en-US", {
                  hour12: false,
                });
                const speaker = record.speaker === "user" ? "User" : "Assistant";
                const preview = record.content.length > 200
                  ? record.content.slice(0, 197) + "..."
                  : record.content;
                return `[${time}] ${speaker}: ${preview}`;
              })
              .join("\n");
            contextParts.push(`[RECENT HISTORY (${recentMessages.length} messages)]\n${formattedHistory}`);
          }
        } catch (historyError) {
          console.error("[CALLBACK] Failed to fetch chat history:", historyError);
          contextParts.push("[RECENT HISTORY: Failed to fetch]");
        }
      } else {
        contextParts.push("[RECENT HISTORY: Chat history is disabled]");
      }

      session.nextQueryContext = contextParts.join("\n\n") + "\n[END CONTEXT]";

      await ctx.editMessageText(
        `📜 ${messageCount}개 메시지 + 최근 대화 기록이 참고 컨텍스트로 저장되었습니다.`
      );
      await ctx.answerCallbackQuery({ text: "Messages + history saved" });
      break;
    }

    default:
      await ctx.answerCallbackQuery({ text: "Unknown action" });
  }
}
