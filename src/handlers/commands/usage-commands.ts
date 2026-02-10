import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  ensureConfigExists,
  getCurrentConfig,
  MODEL_DISPLAY_NAMES,
  REASONING_TOKENS,
} from "../../config/model";
import { type ChatType, isAuthorizedForChat } from "../../security";
import { sessionManager } from "../../core/session/session-manager";
import { skillsRegistry } from "../../services/skills-registry";
import { fetchAllUsage } from "../../usage";
import {
  formatClaudeUsage,
  formatCodexUsage,
  formatDuration,
  formatGeminiUsage,
} from "./formatters";

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
