import type { Context } from "grammy";
import { WORKING_DIR } from "../../config";
import { type ChatType, isAuthorizedForChat } from "../../security";
import { sessionManager } from "../../core/session/session-manager";
import { sendSystemMessage } from "../../utils/system-message";
import { TelegramChoiceBuilder } from "../../utils/telegram-choice-builder";
import { formatDuration } from "./formatters";

/**
 * /new - Start a fresh session for this chat.
 */
export async function handleNew(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type as ChatType | undefined;
  const threadId = ctx.message?.message_thread_id;

  if (!isAuthorizedForChat(userId, chatId, chatType)) {
    if (chatType === "private") {
      await ctx.reply("Unauthorized.");
    }
    return;
  }

  // Get session info before killing
  const sessionKey = sessionManager.deriveKey(chatId!, threadId);
  const oldSession = sessionManager.getSession(chatId!, threadId);
  const oldSessionId = oldSession.sessionId;
  console.log(`[/new] Before kill: sessionId=${oldSessionId?.slice(0, 8) || "null"}`);

  // Kill session and get lost messages
  const { count, messages } = await sessionManager.killSession(chatId!, threadId);
  console.log(`[/new] After kill: lost ${count} messages`);

  if (count > 0 && messages.length > 0) {
    // Set pending recovery on the NEW session (getSession creates if not exists)
    const newSession = sessionManager.getSession(chatId!, threadId);
    newSession.setPendingRecovery(messages, chatId!);

    // Show inline buttons for recovery
    const keyboard = TelegramChoiceBuilder.buildLostMessageKeyboard(sessionKey);
    const messageText = TelegramChoiceBuilder.buildLostMessageText(messages, false);

    const sentMsg = await ctx.reply(messageText, {
      reply_markup: keyboard,
      parse_mode: "Markdown",
    });

    // Update pending recovery with message ID
    newSession.setPendingRecovery(messages, chatId!, sentMsg.message_id);
  } else {
    await sendSystemMessage(ctx, "🆕 Session cleared. Next message starts fresh.");
  }

  // Verify session is actually cleared
  const verifySession = sessionManager.getSession(chatId!, threadId);
  console.log(
    `[/new] Verify after: sessionId=${verifySession.sessionId?.slice(0, 8) || "null"}, isActive=${verifySession.isActive}`
  );
}

/**
 * /stop - Stop the current query (silently) for this chat.
 */
export async function handleStop(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type as ChatType | undefined;
  const threadId = ctx.message?.message_thread_id;

  if (!isAuthorizedForChat(userId, chatId, chatType)) {
    if (chatType === "private") {
      await ctx.reply("Unauthorized.");
    }
    return;
  }

  const session = sessionManager.getSession(chatId!, threadId);
  if (session.isRunning) {
    const result = await session.stop();
    if (result) {
      await Bun.sleep(100);
      session.clearStopRequested();
    }
  }
}

/**
 * /status - Show detailed status for this chat.
 */
export async function handleStatus(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type as ChatType | undefined;
  const threadId = ctx.message?.message_thread_id;

  if (!isAuthorizedForChat(userId, chatId, chatType)) {
    if (chatType === "private") {
      await ctx.reply("Unauthorized.");
    }
    return;
  }

  const session = sessionManager.getSession(chatId!, threadId);
  const lines: string[] = ["📊 <b>Bot Status</b>\n"];

  // Session status
  if (session.isActive) {
    lines.push(`✅ Session: Active (${session.sessionId?.slice(0, 8)}...)`);
    if (session.sessionStartTime) {
      const duration = Math.floor(
        (Date.now() - session.sessionStartTime.getTime()) / 1000
      );
      lines.push(
        `   └─ Duration: ${formatDuration(duration)} | ${session.totalQueries} queries`
      );
    }
  } else {
    lines.push("⚪ Session: None");
  }

  // Query status
  if (session.isRunning) {
    const elapsed = session.queryStarted
      ? Math.floor((Date.now() - session.queryStarted.getTime()) / 1000)
      : 0;
    lines.push(`🔄 Query: Running (${elapsed}s)`);
    if (session.currentTool) {
      lines.push(`   └─ ${session.currentTool}`);
    }
  } else {
    lines.push("⚪ Query: Idle");
    if (session.lastTool) {
      lines.push(`   └─ Last: ${session.lastTool}`);
    }
  }

  // Last activity
  if (session.lastActivity) {
    const ago = Math.floor((Date.now() - session.lastActivity.getTime()) / 1000);
    lines.push(`\n⏱️ Last activity: ${ago}s ago`);
  }

  // Usage stats
  if (session.lastUsage) {
    const usage = session.lastUsage;
    lines.push(
      `\n📈 Last query usage:`,
      `   Input: ${usage.input_tokens?.toLocaleString() || "?"} tokens`,
      `   Output: ${usage.output_tokens?.toLocaleString() || "?"} tokens`
    );
    if (usage.cache_read_input_tokens) {
      lines.push(`   Cache read: ${usage.cache_read_input_tokens.toLocaleString()}`);
    }
  }

  // Error status
  if (session.lastError) {
    const ago = session.lastErrorTime
      ? Math.floor((Date.now() - session.lastErrorTime.getTime()) / 1000)
      : "?";
    lines.push(`\n⚠️ Last error (${ago}s ago):`, `   ${session.lastError}`);
  }

  // Working directory
  lines.push(`\n📁 Working dir: <code>${WORKING_DIR}</code>`);

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

/**
 * /resume - Resume the last session for this chat.
 */
export async function handleResume(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type as ChatType | undefined;
  const threadId = ctx.message?.message_thread_id;

  if (!isAuthorizedForChat(userId, chatId, chatType)) {
    if (chatType === "private") {
      await ctx.reply("Unauthorized.");
    }
    return;
  }

  const session = sessionManager.getSession(chatId!, threadId);
  if (session.isActive) {
    await ctx.reply("Session already active. Use /new to start fresh first.");
    return;
  }

  // Try to load persisted session for this chat
  if (sessionManager.hasSession(chatId!, threadId)) {
    await sendSystemMessage(ctx, `✅ Session resumed for this chat.`);
  } else {
    await sendSystemMessage(ctx, `❌ No saved session found for this chat.`);
  }
}

/**
 * /retry - Retry the last message (resume session and re-send) for this chat.
 */
export async function handleRetry(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type as ChatType | undefined;
  const threadId = ctx.message?.message_thread_id;

  if (!isAuthorizedForChat(userId, chatId, chatType)) {
    if (chatType === "private") {
      await ctx.reply("Unauthorized.");
    }
    return;
  }

  const session = sessionManager.getSession(chatId!, threadId);

  // Check if there's a message to retry
  if (!session.lastMessage) {
    await ctx.reply("❌ No message to retry.");
    return;
  }

  // Check if something is already running
  if (session.isRunning) {
    await ctx.reply("⏳ A query is already running. Use /stop first.");
    return;
  }

  const message = session.lastMessage;
  await ctx.reply(
    `🔄 Retrying: "${message.slice(0, 50)}${message.length > 50 ? "..." : ""}"`
  );

  // Guard: ensure ctx.message exists before spreading
  if (!ctx.message) {
    await ctx.reply("❌ Could not retry: no message context.");
    return;
  }

  // Simulate sending the message again by emitting a fake text message event
  // We do this by directly calling the text handler logic
  const { handleText } = await import("../text");

  // Create a modified context with the last message
  const fakeCtx = {
    ...ctx,
    message: {
      ...ctx.message,
      text: message,
    },
  } as Context;

  await handleText(fakeCtx);
}
