/**
 * Command handlers for Claude Telegram Bot.
 *
 * /start, /new, /stop, /status, /resume, /restart
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sessionManager } from "../session-manager";
import { WORKING_DIR, ALLOWED_USERS, RESTART_FILE } from "../config";
import { sendSystemMessage, addSystemReaction } from "../utils/system-message";
import { type ChatType, isAuthorizedForChat } from "../security";
import { getSchedulerStatus, reloadScheduler } from "../scheduler";
import { fetchAllUsage } from "../usage";
import type { ClaudeUsage, CodexUsage, GeminiUsage } from "../types";
import {
  getCurrentConfig,
  MODEL_DISPLAY_NAMES,
  REASONING_TOKENS,
  ensureConfigExists,
} from "../model-config";
import { skillsRegistry } from "../services/skills-registry";
import { TelegramChoiceBuilder } from "../utils/telegram-choice-builder";

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function formatTimeRemaining(resetTime: string | number | null): string {
  if (!resetTime) return "";

  const resetMs =
    typeof resetTime === "number" ? resetTime * 1000 : new Date(resetTime).getTime();
  const diffMs = resetMs - Date.now();

  if (diffMs <= 0) return "now";

  const diffSec = Math.floor(diffMs / 1000);
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatClaudeUsage(usage: ClaudeUsage): string[] {
  const lines: string[] = ["<b>Claude Code:</b>"];

  if (usage.five_hour) {
    const reset = formatTimeRemaining(usage.five_hour.resets_at);
    lines.push(
      `   5h: ${Math.round(usage.five_hour.utilization)}%${reset ? ` (resets in ${reset})` : ""}`
    );
  }
  if (usage.seven_day) {
    const reset = formatTimeRemaining(usage.seven_day.resets_at);
    lines.push(
      `   7d: ${Math.round(usage.seven_day.utilization)}%${reset ? ` (resets in ${reset})` : ""}`
    );
  }
  if (usage.seven_day_sonnet) {
    const reset = formatTimeRemaining(usage.seven_day_sonnet.resets_at);
    lines.push(
      `   7d Sonnet: ${Math.round(usage.seven_day_sonnet.utilization)}%${reset ? ` (resets in ${reset})` : ""}`
    );
  }

  return lines;
}

function formatCodexUsage(usage: CodexUsage): string[] {
  const lines: string[] = [`<b>OpenAI Codex</b> (${usage.planType}):`];

  if (usage.primary) {
    const reset = formatTimeRemaining(usage.primary.resetAt);
    lines.push(
      `   5h: ${Math.round(usage.primary.usedPercent)}%${reset ? ` (resets in ${reset})` : ""}`
    );
  }
  if (usage.secondary) {
    const reset = formatTimeRemaining(usage.secondary.resetAt);
    lines.push(
      `   7d: ${Math.round(usage.secondary.usedPercent)}%${reset ? ` (resets in ${reset})` : ""}`
    );
  }

  return lines;
}

function formatGeminiUsage(usage: GeminiUsage): string[] {
  const lines: string[] = [`<b>Gemini</b> (${usage.model}):`];

  if (usage.usedPercent !== null) {
    const reset = formatTimeRemaining(usage.resetAt);
    lines.push(
      `   Usage: ${Math.round(usage.usedPercent)}%${reset ? ` (resets in ${reset})` : ""}`
    );
  }

  return lines;
}

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
 * /stats - Show comprehensive token usage and cost statistics for this chat.
 */
export async function handleStats(ctx: Context): Promise<void> {
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
  const lines: string[] = ["📊 <b>Session Statistics</b>\n"];

  // Session info
  if (session.sessionStartTime) {
    const duration = Math.floor(
      (Date.now() - session.sessionStartTime.getTime()) / 1000
    );
    lines.push(`⏱️ Session duration: ${formatDuration(duration)}`);
    lines.push(`🔢 Total queries: ${session.totalQueries}`);
  } else {
    lines.push("⚪ No active session");
  }

  // Token usage
  if (session.totalQueries > 0) {
    const totalIn = session.totalInputTokens;
    const totalOut = session.totalOutputTokens;
    const totalCache = session.totalCacheReadTokens + session.totalCacheCreateTokens;
    const totalTokens = totalIn + totalOut;

    lines.push(`\n🧠 <b>Token Usage</b>`);
    lines.push(`   Input: ${totalIn.toLocaleString()} tokens`);
    lines.push(`   Output: ${totalOut.toLocaleString()} tokens`);
    if (totalCache > 0) {
      lines.push(`   Cache: ${totalCache.toLocaleString()} tokens`);
      lines.push(`     └─ Read: ${session.totalCacheReadTokens.toLocaleString()}`);
      lines.push(`     └─ Create: ${session.totalCacheCreateTokens.toLocaleString()}`);
    }
    lines.push(`   <b>Total: ${totalTokens.toLocaleString()} tokens</b>`);

    // Cost estimation (Claude Sonnet 4 pricing)
    // $3 per MTok input, $15 per MTok output
    // Cache write: $3.75/MTok, Cache read: $0.30/MTok
    const costIn = (totalIn / 1000000) * 3.0;
    const costOut = (totalOut / 1000000) * 15.0;
    const costCacheRead = (session.totalCacheReadTokens / 1000000) * 0.3;
    const costCacheWrite = (session.totalCacheCreateTokens / 1000000) * 3.75;
    const totalCost = costIn + costOut + costCacheRead + costCacheWrite;

    lines.push(`\n💰 <b>Estimated Cost</b>`);
    lines.push(`   Input: $${costIn.toFixed(4)}`);
    lines.push(`   Output: $${costOut.toFixed(4)}`);
    if (totalCache > 0) {
      lines.push(`   Cache: $${(costCacheRead + costCacheWrite).toFixed(4)}`);
    }
    lines.push(`   <b>Total: $${totalCost.toFixed(4)}</b>`);

    // Efficiency metrics
    if (session.totalQueries > 1) {
      const avgIn = Math.floor(totalIn / session.totalQueries);
      const avgOut = Math.floor(totalOut / session.totalQueries);
      const avgCost = totalCost / session.totalQueries;

      lines.push(`\n📈 <b>Per Query Average</b>`);
      lines.push(`   Input: ${avgIn.toLocaleString()} tokens`);
      lines.push(`   Output: ${avgOut.toLocaleString()} tokens`);
      lines.push(`   Cost: $${avgCost.toFixed(4)}`);
    }
  } else {
    lines.push(`\n📭 No queries in this session yet`);
  }

  // Last query
  if (session.lastUsage) {
    const u = session.lastUsage;
    lines.push(`\n🔍 <b>Last Query</b>`);
    lines.push(`   Input: ${u.input_tokens.toLocaleString()} tokens`);
    lines.push(`   Output: ${u.output_tokens.toLocaleString()} tokens`);
    if (u.cache_read_input_tokens) {
      lines.push(`   Cache read: ${u.cache_read_input_tokens.toLocaleString()}`);
    }
  }

  // Fetch provider usage in parallel
  lines.push(`\n🌐 <b>Provider Usage</b>`);
  const allUsage = await fetchAllUsage();

  if (allUsage.claude) {
    lines.push(...formatClaudeUsage(allUsage.claude));
  }
  if (allUsage.codex) {
    lines.push(...formatCodexUsage(allUsage.codex));
  }
  if (allUsage.gemini) {
    lines.push(...formatGeminiUsage(allUsage.gemini));
  }

  if (!allUsage.claude && !allUsage.codex && !allUsage.gemini) {
    lines.push("   <i>No providers authenticated</i>");
  }

  lines.push(`\n<i>Pricing: Claude Sonnet 4 rates</i>`);

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
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
  const { handleText } = await import("./text");

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

/**
 * /context - Display context window utilization against the current model's input token limit (default 200K).
 * Shows current input tokens (which count toward context) vs output tokens (which don't).
 */
export async function handleContext(ctx: Context): Promise<void> {
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

  try {
    const session = sessionManager.getSession(chatId!, threadId);

    // Use last-known context usage snapshot (updated after each query, persisted across restarts)
    const contextLimit = session.contextWindowSize || 200_000;
    const contextUsed = session.currentContextTokens;
    const percentage = ((contextUsed / contextLimit) * 100).toFixed(1);

    // Format numbers with commas for readability
    const formatNumber = (n: number): string => n.toLocaleString("en-US");

    // Get breakdown if lastUsage available
    const usage = session.lastUsage;
    const breakdown = usage
      ? `\n\nLast query:\n` +
        `Input: ${formatNumber(usage.input_tokens)}\n` +
        `Output: ${formatNumber(usage.output_tokens)}\n` +
        (usage.cache_read_input_tokens
          ? `Cache read: ${formatNumber(usage.cache_read_input_tokens)}\n`
          : "") +
        (usage.cache_creation_input_tokens
          ? `Cache created: ${formatNumber(usage.cache_creation_input_tokens)}`
          : "")
      : "";

    await ctx.reply(
      `⚙️ <b>Context Window Usage</b>\n\n` +
        `📊 <code>${formatNumber(contextUsed)} / ${formatNumber(contextLimit)}</code> tokens (<b>${percentage}%</b>)` +
        breakdown,
      { parse_mode: "HTML" }
    );
  } catch (error) {
    console.error(
      "[ERROR:CONTEXT_COMMAND_FAILED] Failed to retrieve context usage:",
      error instanceof Error ? error.message : String(error)
    );
    await ctx.reply(
      "❌ Failed to retrieve context usage. Please try again.\n\n" +
        "If this persists, restart the session with /new"
    );
  }
}

/**
 * /skills - Show quick skills menu
 */
export async function handleSkills(ctx: Context): Promise<void> {
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
    const skills = await skillsRegistry.sync();

    if (skills.length === 0) {
      await ctx.reply(
        `🛠️ <b>Quick Skills</b>\n\n` +
          `<i>No skills registered.</i>\n\n` +
          `Say "add do-work to skills menu" to add a skill.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const keyboard = new InlineKeyboard();
    const maxButtons = 8;
    const displaySkills = skills.slice(0, maxButtons);

    for (let i = 0; i < displaySkills.length; i += 2) {
      const skill1 = displaySkills[i];
      const skill2 = displaySkills[i + 1];

      if (skill1 && skill2) {
        keyboard.text(skill1, `sk:${skill1}`).text(skill2, `sk:${skill2}`).row();
      } else if (skill1) {
        keyboard.text(skill1, `sk:${skill1}`).row();
      }
    }

    keyboard.text("⚙️ Manage", "sk:manage");

    await ctx.reply(
      `🛠️ <b>Quick Skills</b>\n\n` +
        `Use /skills to access frequently-used SuperClaude skills.\n` +
        `To customize: "add/remove {skill} to/from skills menu"`,
      {
        parse_mode: "HTML",
        reply_markup: keyboard,
      }
    );
  } catch (error) {
    console.error(
      "[ERROR:SKILLS_COMMAND_FAILED] Failed to show skills menu:",
      error instanceof Error ? error.message : String(error)
    );
    await ctx.reply("❌ Failed to load skills menu. Please try again.");
  }
}

/**
 * /model - Configure model and reasoning settings
 */
export async function handleModel(ctx: Context): Promise<void> {
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
    // Ensure config file exists
    await ensureConfigExists();

    // Get current config
    const config = getCurrentConfig();

    // Build context selection keyboard
    const keyboard = new InlineKeyboard()
      .text("💬 Chat Model", "model:context:general")
      .row()
      .text("📝 Summary Model", "model:context:summary")
      .row()
      .text("⏰ Cron Model", "model:context:cron");

    // Format current config display
    const generalModel = config.contexts.general?.model || config.defaults.model;
    const generalReasoning =
      config.contexts.general?.reasoning || config.defaults.reasoning;
    const summaryModel = config.contexts.summary?.model || config.defaults.model;
    const summaryReasoning =
      config.contexts.summary?.reasoning || config.defaults.reasoning;
    const cronModel = config.contexts.cron?.model || config.defaults.model;
    const cronReasoning = config.contexts.cron?.reasoning || config.defaults.reasoning;

    await ctx.reply(
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
  } catch (error) {
    console.error(
      "[ERROR:MODEL_COMMAND_FAILED] Failed to show model config:",
      error instanceof Error ? error.message : String(error)
    );
    await ctx.reply("❌ Failed to show model configuration. Please try again.");
  }
}
