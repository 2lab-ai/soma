import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { EFFORT_LEVELS, type EffortLevel, isEffortLevel } from "soma-lib";
import {
  ensureConfigExists,
  getCurrentConfig,
  getEffortForContext,
  updateContextModel,
} from "../../config/model";
import { isLlmuxMode } from "../../config/llmux";
import {
  getDisplayName,
  getKnownAliases,
  getSupportedEfforts,
  refreshCatalogIfStale,
  resolveModelInput,
} from "../../config/model-catalog";
import { contextEffortSummary, effortSummary } from "../effort-display";
import { type ChatType, isAuthorizedForChat } from "../../security";
import { sessionManager } from "../../core/session/session-manager";
import {
  calculateContextUsagePercent,
  DEFAULT_CONTEXT_WINDOW_SIZE,
} from "../../core/session/session-helpers";
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
 * /context - Display current context window utilization against the active limit.
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

    const contextLimit =
      session.actualContextMax ??
      session.contextWindowSize ??
      DEFAULT_CONTEXT_WINDOW_SIZE;
    const contextUsed = session.currentContextTokens;
    const percentage = (
      calculateContextUsagePercent(contextUsed, contextLimit) ?? 0
    ).toFixed(1);

    // Format numbers with commas for readability
    const formatNumber = (n: number): string => n.toLocaleString("en-US");

    const usage = session.contextWindowUsage ?? session.lastUsage;
    const breakdown = usage
      ? `\n\nLast query:\n` +
        `Input: ${formatNumber(usage.input_tokens)}\n` +
        `Output: ${formatNumber(usage.output_tokens || 0)}\n` +
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

/** Escape the three characters Telegram's HTML parse mode reads as markup. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * `/model <model> [effort]` — set the CHAT (general) context in one message.
 *
 * `<model>` may be an exact id or a shorthand, in which case it resolves to the
 * newest `[1m]` model of that family (`fable` → `claude-fable-5-1[1m]`); see
 * `config/model-alias.ts` for the rules. `[effort]` is the level to persist as
 * typed — the clamp onto what the model actually supports is displayed, not
 * saved, exactly like the keyboard's save path in `callback.ts`.
 *
 * Nothing is persisted on any rejected input.
 */
async function applyModelArguments(ctx: Context, tokens: string[]): Promise<void> {
  if (tokens.length > 2) {
    await ctx.reply(
      `❓ Usage: /model &lt;model&gt; [effort]\n\n` +
        `Example: <code>/model fable xhigh</code>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  // "Newest" has to mean newest NOW, so ask llmux before resolving. A dead or
  // slow proxy is not fatal: fall back to the snapshot the module already holds.
  if (isLlmuxMode()) {
    try {
      await refreshCatalogIfStale();
    } catch (error) {
      console.warn(
        "[Model] Catalog refresh failed, resolving against the last snapshot:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  const token = tokens[0] ?? "";
  const resolution = resolveModelInput(token);

  if (resolution.kind === "unknown") {
    // In oauth mode the catalog contributes nothing, so there is no shorthand to
    // suggest — an empty list ("Try one of:  or an exact model id") would read
    // as a bug in the bot rather than as an answer.
    const aliases = getKnownAliases();
    await ctx.reply(
      aliases.length > 0
        ? `❓ Unknown model <code>${escapeHtml(token)}</code>. Try one of: ` +
            `${escapeHtml(aliases.join(", "))} or an exact model id.`
        : `❓ Unknown model <code>${escapeHtml(token)}</code>. Use an exact model id.`,
      { parse_mode: "HTML" }
    );
    return;
  }
  if (resolution.kind === "ambiguous") {
    await ctx.reply(
      `❓ <code>${escapeHtml(token)}</code> matches more than one family. Be more specific:\n` +
        resolution.candidates.map((id) => `<code>${escapeHtml(id)}</code>`).join("\n"),
      { parse_mode: "HTML" }
    );
    return;
  }

  const modelId = resolution.id;
  const effortToken = tokens[1];
  let effort: EffortLevel | undefined;
  if (effortToken !== undefined) {
    const level = effortToken.trim().toLowerCase();
    if (!isEffortLevel(level)) {
      await ctx.reply(
        `❓ Unknown effort <code>${escapeHtml(effortToken)}</code>. ` +
          `Levels: ${EFFORT_LEVELS.join(", ")}.`,
        { parse_mode: "HTML" }
      );
      return;
    }
    effort = level;
  }

  // A model with no effort menu is driven by the message-keyword thinking
  // budget, so an effort argument for it is reported back, not persisted (the
  // keyboard does the same via its `-` sentinel).
  const hasEffortMenu = getSupportedEfforts(modelId).length > 0;
  await updateContextModel("general", modelId, hasEffortMenu ? effort : undefined);

  const lines = [
    `✅ <b>Chat model</b> → ${escapeHtml(getDisplayName(modelId))} <code>${escapeHtml(modelId)}</code>`,
    effortSummary(modelId, getEffortForContext("general")),
  ];
  if (
    resolution.kind === "resolved" &&
    modelId.toLowerCase() !== token.trim().toLowerCase()
  ) {
    const what = modelId.toLowerCase().endsWith("[1m]")
      ? `newest 1M of the ${resolution.family} family`
      : `newest of the ${resolution.family} family`;
    lines.push(`<i>${escapeHtml(token)} → ${what}</i>`);
  }
  if (effort !== undefined && !hasEffortMenu) {
    lines.push(
      `<i>Effort ${effort} ignored — this model takes its thinking budget from ` +
        `message keywords.</i>`
    );
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

/**
 * /model - Configure model and reasoning settings.
 *
 * Bare `/model` opens the 3-context keyboard; `/model <model> [effort]` sets the
 * chat context straight away ({@link applyModelArguments}).
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

    // `/model` and `/model@botname` both carry their arguments after the
    // command word (same stripping convention as /cron).
    const text = ctx.message?.text || "";
    const args = text.replace(/^\/model(@\S+)?/i, "").trim();
    if (args.length > 0) {
      await applyModelArguments(ctx, args.split(/\s+/));
      return;
    }

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
    const summaryModel = config.contexts.summary?.model || config.defaults.model;
    const cronModel = config.contexts.cron?.model || config.defaults.model;

    await ctx.reply(
      `🤖 <b>Model Configuration</b>\n\n` +
        `<b>Current Settings:</b>\n\n` +
        `💬 <b>Chat:</b> ${getDisplayName(generalModel)} (${contextEffortSummary(config, "general")})\n` +
        `📝 <b>Summary:</b> ${getDisplayName(summaryModel)} (${contextEffortSummary(config, "summary")})\n` +
        `⏰ <b>Cron:</b> ${getDisplayName(cronModel)} (${contextEffortSummary(config, "cron")})\n\n` +
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
