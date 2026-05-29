import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sessionManager } from "../core/session/session-manager";
import type { ClaudeSession } from "../core/session/session";
import { type ChatType, isAuthorizedForChat } from "../security";
import { pendingGroupStore } from "../core/pending-group-store";
import { groupRegistry } from "../core/group-registry";
import { auditLog } from "../utils/audit";
import { startTypingIndicator } from "../utils/typing";
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
  isOpusFamily,
  updateContextModel,
  MODEL_DISPLAY_NAMES,
  AVAILABLE_MODELS,
  REASONING_TOKENS,
  type ConfigContext,
  type ModelId,
  type ReasoningLevel,
} from "../config/model";
import { decodeModelId, encodeModelId } from "./model-callback-id";
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
  if (session.isProcessing) {
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
      statusCallback,
      chatId,
      "general",
      userId
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
  const sessionKey = sessionManager.deriveKey(chatId, threadId);
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
        await ctx.editMessageText(
          `${transition.questionText}\n\n✓ ${transition.selectedLabel}`
        );
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
            `model:model:${context}:${encodeModelId(modelId)}`
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
      const modelShort = parts[3] || "";
      const modelId = decodeModelId(modelShort);
      if (!modelId) {
        await ctx.answerCallbackQuery({
          text: "This selection is no longer valid (the menu may have been replaced). Re-open /model.",
        });
        return;
      }
      const config = getCurrentConfig();
      const currentReasoning =
        config.contexts[context]?.reasoning || config.defaults.reasoning;

      const keyboard = new InlineKeyboard();

      // Opus 4.x ignores per-context reasoning: it always runs adaptive
      // thinking + xhigh effort. Persist xhigh and skip the chooser.
      if (isOpusFamily(modelId)) {
        keyboard
          .text(
            "Save (xhigh)",
            `model:save:${context}:${modelShort}:xhigh`
          )
          .row();
        keyboard.text("« Back", `model:context:${context}`);

        await ctx.editMessageText(
          `🧠 <b>Reasoning Budget</b>\n\n` +
            `Model: ${MODEL_DISPLAY_NAMES[modelId]}\n` +
            `Context: ${context.charAt(0).toUpperCase() + context.slice(1)}\n\n` +
            `ℹ️ Opus 4.7 uses adaptive thinking + xhigh effort. ` +
            `This setting is ignored.`,
          {
            parse_mode: "HTML",
            reply_markup: keyboard,
          }
        );
      } else {
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
      }
    } else if (action === "save") {
      // Save configuration
      const context = parts[2] as ConfigContext;
      const modelShort = parts[3] || "";
      const reasoning = parts[4] as ReasoningLevel;
      const modelId = decodeModelId(modelShort);
      if (!modelId) {
        await ctx.answerCallbackQuery({
          text: "This selection is no longer valid (the menu may have been replaced). Re-open /model.",
        });
        return;
      }

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

      // Opus 4.x always runs adaptive thinking + xhigh effort regardless of
      // the persisted reasoning level. Render that fact instead of a token
      // budget so the UI matches actual SDK behavior.
      const reasoningSummary = (model: ModelId, reasoning: ReasoningLevel): string =>
        isOpusFamily(model)
          ? `adaptive + xhigh (fixed)`
          : `${reasoning}, ${REASONING_TOKENS[reasoning]} tokens`;

      await ctx.editMessageText(
        `🤖 <b>Model Configuration</b>\n\n` +
          `<b>Current Settings:</b>\n\n` +
          `💬 <b>Chat:</b> ${MODEL_DISPLAY_NAMES[generalModel]} (${reasoningSummary(generalModel, generalReasoning)})\n` +
          `📝 <b>Summary:</b> ${MODEL_DISPLAY_NAMES[summaryModel]} (${reasoningSummary(summaryModel, summaryReasoning)})\n` +
          `⏰ <b>Cron:</b> ${MODEL_DISPLAY_NAMES[cronModel]} (${reasoningSummary(cronModel, cronReasoning)})\n\n` +
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
  } catch (e) { console.warn("[CALLBACK] editMessageText failed:", e); }

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

  if (callbackData.startsWith("grp:")) {
    await handleGroupConfirmCallback(ctx, callbackData, userId);
    return;
  }

  if (callbackData.startsWith("lost:")) {
    await handleLostMessageCallback(
      ctx,
      callbackData,
      chatId,
      threadId,
      userId,
      username
    );
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
  _username: string
): Promise<void> {
  const parts = callbackData.split(":");
  if (parts.length !== 3) {
    await ctx.answerCallbackQuery({ text: "Invalid callback format" });
    return;
  }

  const [, compressedKey, action] = parts;
  const session = sessionManager.getSession(chatId, threadId);

  // Validate session key matches
  const sessionKey = sessionManager.deriveKey(chatId, threadId);
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

        session.nextQueryContext = { userId, context: `[CONTEXT FROM PREVIOUS SESSION - 이전 세션에서 전달되지 않은 메시지입니다. 참고용으로 포함되었습니다.]\n${formattedContext}\n[END CONTEXT]` };
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
        contextParts.push(
          `[UNDELIVERED MESSAGES (${resolved.length})]\n${formattedLost}`
        );
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
                const preview =
                  record.content.length > 200
                    ? record.content.slice(0, 197) + "..."
                    : record.content;
                return `[${time}] ${speaker}: ${preview}`;
              })
              .join("\n");
            contextParts.push(
              `[RECENT HISTORY (${recentMessages.length} messages)]\n${formattedHistory}`
            );
          }
        } catch (historyError) {
          console.error("[CALLBACK] Failed to fetch chat history:", historyError);
          contextParts.push("[RECENT HISTORY: Failed to fetch]");
        }
      } else {
        contextParts.push("[RECENT HISTORY: Chat history is disabled]");
      }

      session.nextQueryContext = { userId, context: contextParts.join("\n\n") + "\n[END CONTEXT]" };

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

/**
 * Handle group activation confirmation callbacks.
 * Format: grp:{chatId}:{action} where action = "accept" | "reject"
 *
 * Trace: docs/group-owner-confirm/trace.md, Scenarios 2-3
 */
async function handleGroupConfirmCallback(
  ctx: Context,
  callbackData: string,
  userId: number
): Promise<void> {
  const parts = callbackData.split(":");
  if (parts.length !== 3) {
    await ctx.answerCallbackQuery({ text: "Invalid callback format" });
    return;
  }

  const chatId = Number(parts[1]);
  const action = parts[2];

  if (!Number.isFinite(chatId)) {
    await ctx.answerCallbackQuery({ text: "Invalid group ID" });
    return;
  }

  // Get pending confirmation
  const pending = pendingGroupStore.get(chatId);
  if (!pending) {
    await ctx.answerCallbackQuery({ text: "요청이 만료되었습니다" });
    try {
      await ctx.editMessageText("⏰ 이 요청은 만료되었습니다.");
    } catch (e) { console.warn("[CALLBACK] expired edit failed:", e); }
    return;
  }

  // Validate: only the owner can confirm
  if (userId !== pending.ownerId) {
    await ctx.answerCallbackQuery({ text: "권한이 없습니다" });
    return;
  }

  // Validate: stale button guard — reject if DM message doesn't match current pending
  const callbackMessageId = ctx.callbackQuery?.message?.message_id;
  if (callbackMessageId && pending.dmMessageId && callbackMessageId !== pending.dmMessageId) {
    await ctx.answerCallbackQuery({ text: "이 요청은 더 이상 유효하지 않습니다" });
    try {
      await ctx.editMessageText("⏰ 이 요청은 새로운 요청으로 대체되었습니다.");
    } catch (e) { console.warn("[CALLBACK] superseded edit failed:", e); }
    return;
  }

  if (action === "accept") {
    // Trace S2: accept → register with ownerId → welcome message
    // Register FIRST — only remove pending on success (so retry is possible)
    const registered = groupRegistry.register(chatId, pending.ownerId);

    if (!registered) {
      await ctx.answerCallbackQuery({ text: "등록 실패. 다시 시도해주세요" });
      return;
    }
    pendingGroupStore.remove(chatId);

    try {
      await ctx.editMessageText(
        `✅ 그룹 <b>${escapeHtml(pending.chatTitle)}</b> 활성화됨\n이제 이 그룹에서 메시지에 응답합니다.`,
        { parse_mode: "HTML" }
      );
    } catch (e) { console.warn("[CALLBACK] group-approve edit failed:", e); }

    // Send welcome message to the group
    try {
      await ctx.api.sendMessage(
        chatId,
        "안녕하세요! 이 그룹에서 도움이 필요하시면 말씀해 주세요. 🤖"
      );
    } catch (error) {
      console.error(
        `[GroupConfirm] Failed to send welcome to group ${chatId}:`,
        error
      );
    }

    await ctx.answerCallbackQuery({ text: "그룹 활성화됨" });
    console.log(`[GroupConfirm] Owner ${userId} accepted group ${chatId}`);
  } else if (action === "reject") {
    // Trace S3: reject → remove pending, no registration
    pendingGroupStore.remove(chatId);

    try {
      await ctx.editMessageText(
        `❌ 그룹 <b>${escapeHtml(pending.chatTitle)}</b> 거부됨\n봇은 그룹에 남아있지만 응답하지 않습니다.`,
        { parse_mode: "HTML" }
      );
    } catch (e) { console.warn("[CALLBACK] group-deny edit failed:", e); }

    await ctx.answerCallbackQuery({ text: "그룹 거부됨" });
    console.log(`[GroupConfirm] Owner ${userId} rejected group ${chatId}`);
  } else {
    await ctx.answerCallbackQuery({ text: "Unknown action" });
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
