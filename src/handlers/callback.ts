import type { Context } from "grammy";
import { unlinkSync } from "fs";
import { sessionManager } from "../session-manager";
import type { ClaudeSession } from "../session";
import { type ChatType, isAuthorizedForChat } from "../security";
import { auditLog, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";
import { TelegramChoiceBuilder } from "../utils/telegram-choice-builder";

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

    for (const toolMsg of state.toolMessages) {
      try {
        await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
      } catch {
        // Tool message already deleted
      }
    }

    const errorStr = String(error);
    if (errorStr.includes("abort") || errorStr.includes("cancel")) {
      const wasInterrupt = session.consumeInterruptFlag();
      if (!wasInterrupt) {
        await ctx.reply("🛑 Query stopped.");
      }
    } else {
      await ctx.reply(`❌ Error: ${errorStr.slice(0, 200)}`);
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
    await ctx.answerCallbackQuery({ text: "Selection expired. Please ask again." });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch {
      // Message too old to edit
    }
    return;
  }

  // Check if choiceState exists
  if (!session.choiceState) {
    await ctx.answerCallbackQuery({
      text: "Session expired. Type your choice directly.",
    });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch {
      // Message too old to edit
    }
    return;
  }

  // Validate that callback is for the current choice message
  const callbackMessageId = (
    ctx.callbackQuery?.message as { message_id?: number } | undefined
  )?.message_id;
  if (callbackMessageId && session.choiceState.messageId !== callbackMessageId) {
    await ctx.answerCallbackQuery({ text: "This choice is outdated." });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch {
      // Message too old to edit
    }
    return;
  }

  // Handle direct input
  const lastPart = parts[parts.length - 1]!;
  if (lastPart === "__direct") {
    const questionId = parts.length === 4 ? parts[2] : undefined;
    session.pendingDirectInput = {
      type: session.choiceState.type,
      formId: session.choiceState.formId,
      questionId,
      messageId: session.choiceState.messageId,
    };
    await ctx.answerCallbackQuery({ text: "Type your answer:" });
    await ctx.editMessageText("✏️ Waiting for your input...");
    return;
  }

  // Get selection based on single vs multi
  let selectedLabel: string;

  if (session.choiceState.type === "single") {
    // Single choice: parts[2] is optId
    const optId = parts[2]!;
    const choice = session.choiceState.extractedChoice;
    if (!choice) {
      await ctx.answerCallbackQuery({ text: "Choice data not found" });
      return;
    }

    const option = choice.choices.find((opt) => opt.id === optId);
    if (!option) {
      await ctx.answerCallbackQuery({ text: "Invalid option" });
      return;
    }

    selectedLabel = option.label;
  } else {
    // Multi choice: parts[2] is qId, parts[3] is optId
    if (parts.length !== 4) {
      await ctx.answerCallbackQuery({ text: "Invalid multi-form callback" });
      return;
    }

    const questionId = parts[2]!;
    const optId = parts[3]!;
    const choices = session.choiceState.extractedChoices;
    if (!choices) {
      await ctx.answerCallbackQuery({ text: "Form data not found" });
      return;
    }

    const question = choices.questions.find((q) => q.id === questionId);
    if (!question) {
      await ctx.answerCallbackQuery({ text: "Question not found" });
      return;
    }

    const option = question.choices.find((opt) => opt.id === optId);
    if (!option) {
      await ctx.answerCallbackQuery({ text: "Invalid option" });
      return;
    }

    selectedLabel = option.label;

    // Store selection in choiceState
    if (!session.choiceState.selections) {
      session.choiceState.selections = {};
    }
    session.choiceState.selections[questionId] = {
      choiceId: optId,
      label: selectedLabel,
    };

    // Check if all questions answered
    const allAnswered =
      Object.keys(session.choiceState.selections).length === choices.questions.length;

    if (!allAnswered) {
      // Not all questions answered yet, just acknowledge
      // Edit to show selection but keep question visible
      await ctx.editMessageText(`${question.question}\n\n✓ ${selectedLabel}`);
      // Remove keyboard from this question since it's answered
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      await ctx.answerCallbackQuery({
        text: `Selected: ${selectedLabel.slice(0, 50)}`,
      });
      return;
    }

    // All answered - build combined message
    const answers = choices.questions
      .map((q) => {
        const sel = session.choiceState?.selections?.[q.id];
        return sel ? `${q.question}: ${sel.label}` : null;
      })
      .filter(Boolean)
      .join("\n");

    selectedLabel = `Answered all questions:\n${answers}`;
  }

  // Clear choice state
  session.clearChoiceState();
  session.setActivityState("working");

  // Update message to show selection
  try {
    await ctx.editMessageText(`✓ ${selectedLabel}`);
  } catch (error) {
    console.debug("Failed to edit callback message:", error);
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

export async function handleCallback(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type as ChatType | undefined;
  // Callback queries don't have message_thread_id directly, use from message if available
  const threadId = (
    ctx.callbackQuery?.message as { message_thread_id?: number } | undefined
  )?.message_thread_id;
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

  if (!callbackData.startsWith("askuser:")) {
    await ctx.answerCallbackQuery();
    return;
  }

  const parts = callbackData.split(":");
  if (parts.length !== 3) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  const requestId = parts[1]!;
  const optionIndex = parseInt(parts[2]!, 10);
  const requestFile = `/tmp/ask-user-${requestId}.json`;

  let requestData: { question: string; options: string[]; status: string };
  try {
    const file = Bun.file(requestFile);
    requestData = JSON.parse(await file.text());
  } catch (error) {
    console.error(`Failed to load ask-user request ${requestId}:`, error);
    await ctx.answerCallbackQuery({ text: "Request expired or invalid" });
    return;
  }

  if (optionIndex < 0 || optionIndex >= requestData.options.length) {
    await ctx.answerCallbackQuery({ text: "Invalid option" });
    return;
  }

  const selectedOption = requestData.options[optionIndex]!;

  try {
    await ctx.editMessageText(`✓ ${selectedOption}`);
  } catch {
    // Message may already be edited
  }

  await ctx.answerCallbackQuery({ text: `Selected: ${selectedOption.slice(0, 50)}` });

  try {
    unlinkSync(requestFile);
  } catch {
    // Request file already deleted
  }

  const session = sessionManager.getSession(chatId, threadId);
  await sendMessageToClaude(
    ctx,
    session,
    selectedOption,
    userId,
    username,
    chatId,
    "CALLBACK"
  );
}
