import type { Context } from "grammy";
import { ALLOWED_USERS, RESTART_FILE, WORKING_DIR } from "../../config";
import { type ChatType, isAuthorizedForChat } from "../../security";
import { getSchedulerStatus, reloadScheduler } from "../../scheduler/service";
import { sessionManager } from "../../core/session/session-manager";
import { addSystemReaction, sendSystemMessage } from "../../utils/system-message";

/**
 * /start - Show welcome message and status.
 */
export async function handleStart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type as ChatType | undefined;
  const threadId = ctx.message?.message_thread_id;

  if (!isAuthorizedForChat(userId, chatId, chatType)) {
    if (chatType === "private") {
      await ctx.reply("Unauthorized. Contact the bot owner for access.");
    }
    return;
  }

  const session = sessionManager.getSession(chatId!, threadId);
  const status = session.isActive ? "Active session" : "No active session";
  const workDir = WORKING_DIR;
  const chatInfo = chatType !== "private" ? `\nChat: ${chatId}` : "";

  await ctx.reply(
    `🤖 <b>Claude Telegram Bot</b>\n\n` +
      `Status: ${status}${chatInfo}\n` +
      `Working directory: <code>${workDir}</code>\n\n` +
      `Type /help to see all available commands.`,
    { parse_mode: "HTML" }
  );
}

/**
 * /help - Show complete command list with descriptions, usage tips, and examples.
 */
export async function handleHelp(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type as ChatType | undefined;

  if (!isAuthorizedForChat(userId, chatId, chatType)) {
    if (chatType === "private") {
      await ctx.reply("Unauthorized.");
    }
    return;
  }

  try {
    await ctx.reply(
      `⚙️ <b>Available Commands</b>\n\n` +
        `<b>Session Management:</b>\n` +
        `/start - Welcome message and status\n` +
        `/new - Start fresh Claude session\n` +
        `/resume - Resume last saved session\n` +
        `/stop - Stop current query (silent)\n` +
        `/restart - Restart the bot process\n\n` +
        `<b>Information:</b>\n` +
        `/status - Show current session details\n` +
        `/stats - Token usage & cost statistics\n` +
        `/context - Context window usage (200K limit)\n` +
        `/model - Configure model & reasoning settings\n` +
        `/skills - Quick access to SuperClaude skills\n` +
        `/help - Show this command list\n\n` +
        `<b>Utilities:</b>\n` +
        `/retry - Retry last message\n` +
        `/cron [reload] - Scheduled jobs status/reload\n\n` +
        `<b>💡 Tips:</b>\n` +
        `• Prefix with <code>!</code> to interrupt current query\n` +
        `• Use "think" keyword for extended reasoning (10K tokens)\n` +
        `• Use "ultrathink" for deep analysis (50K tokens)\n` +
        `• Send photos, voice messages, or documents\n` +
        `• Multiple photos = album (auto-grouped)`,
      { parse_mode: "HTML" }
    );
  } catch (error) {
    console.error(
      "[ERROR:HELP_COMMAND_FAILED] Failed to send help message:",
      error instanceof Error ? error.message : String(error)
    );

    // Fallback: Try plain text version
    try {
      await ctx.reply(
        "Available commands:\n" +
          "/start, /new, /resume, /stop, /restart, /status, /stats, /context, /help, /retry, /cron\n\n" +
          "For details, contact the administrator."
      );
    } catch (fallbackError) {
      console.error(
        "[ERROR:HELP_FALLBACK_FAILED] Even plain text help failed:",
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      );
    }
  }
}

/**
 * /restart - Restart the bot process (admin only).
 */
export async function handleRestart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  // Restart is admin-only (must be in ALLOWED_USERS)
  if (!userId || !ALLOWED_USERS.includes(userId)) {
    await ctx.reply("Unauthorized. Only admins can restart the bot.");
    return;
  }

  const msg = await ctx.reply("🔄 Restarting bot...");
  addSystemReaction(ctx.api, msg.chat.id, msg.message_id).catch(() => {});

  // Save message info so we can update it after restart
  if (chatId && msg.message_id) {
    try {
      await Bun.write(
        RESTART_FILE,
        JSON.stringify({
          chat_id: chatId,
          message_id: msg.message_id,
          timestamp: Date.now(),
        })
      );
    } catch (e) {
      console.warn("Failed to save restart info:", e);
    }
  }

  // Give time for the message to send
  await Bun.sleep(500);

  // Exit - launchd will restart us
  process.exit(0);
}

/**
 * /cron - Show cron scheduler status or reload (admin only).
 */
export async function handleCron(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  // Cron is admin-only
  if (!userId || !ALLOWED_USERS.includes(userId)) {
    await ctx.reply("Unauthorized. Only admins can manage cron.");
    return;
  }

  const text = ctx.message?.text || "";
  const arg = text.replace("/cron", "").trim().toLowerCase();

  if (arg === "reload") {
    const count = reloadScheduler();
    if (count === 0) {
      await sendSystemMessage(ctx, "⚠️ No schedules found in cron.yaml");
    } else {
      await sendSystemMessage(
        ctx,
        `🔄 Reloaded ${count} scheduled job${count > 1 ? "s" : ""}`
      );
    }
    return;
  }

  const status = getSchedulerStatus();
  await ctx.reply(
    `${status}\n\n<i>cron.yaml is auto-monitored for changes.\nYou can also use /cron reload to force reload.</i>`,
    { parse_mode: "HTML" }
  );
}

/**
 * /sessions - List all active sessions (admin only).
 */
export async function handleSessions(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!userId || !ALLOWED_USERS.includes(userId)) {
    await ctx.reply("Unauthorized. Only admins can view all sessions.");
    return;
  }

  const stats = sessionManager.getGlobalStats();
  const lines: string[] = ["📋 <b>Active Sessions</b>\n"];

  lines.push(
    `Total: ${stats.totalSessions} session${stats.totalSessions !== 1 ? "s" : ""}`
  );
  lines.push(`Queries: ${stats.totalQueries}`);
  lines.push(
    `Tokens: ${stats.totalInputTokens.toLocaleString()} in / ${stats.totalOutputTokens.toLocaleString()} out\n`
  );

  if (stats.sessions.length === 0) {
    lines.push("<i>No active sessions</i>");
  } else {
    for (const s of stats.sessions.slice(0, 20)) {
      const ago = Math.floor((Date.now() - s.lastActivity.getTime()) / 1000);
      const status = s.isRunning ? "🔄" : s.isActive ? "✅" : "⚪";
      lines.push(
        `${status} <code>${s.sessionKey}</code>: ${s.queries} queries, ${ago}s ago`
      );
    }
    if (stats.sessions.length > 20) {
      lines.push(`\n<i>...and ${stats.sessions.length - 20} more</i>`);
    }
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}
