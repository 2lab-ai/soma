/**
 * Natural Language Skills Registry Management
 *
 * Detects user intent to manage skills via natural language and
 * executes registry operations without Claude API call.
 *
 * Patterns detected:
 *   - "add {skill} to skills menu"
 *   - "remove {skill} from skills menu"
 *   - "show skills registry" / "show skills menu"
 *   - "reset skills to default" / "reset skills menu to defaults"
 */

import type { Context } from "grammy";
import { skillsRegistry } from "../../services/skills-registry";

// ─── Pattern Definitions ──────────────────────────────────────────────

const ADD_PATTERN = /^add\s+([a-z0-9][a-z0-9-]*)\s+to\s+skills?\s*(menu|registry)?$/i;
const REMOVE_PATTERN =
  /^remove\s+([a-z0-9][a-z0-9-]*)\s+from\s+skills?\s*(menu|registry)?$/i;
const SHOW_PATTERN = /^show\s+skills?\s*(menu|registry)?$/i;
const RESET_PATTERN = /^reset\s+skills?\s*(menu|registry)?\s*(to\s+defaults?)?$/i;

// ─── Handler ──────────────────────────────────────────────────────────

/**
 * Attempt to handle message as a natural language skills command.
 * Returns true if handled (caller should stop processing).
 */
export async function handleNaturalLanguageSkills(
  ctx: Context,
  message: string
): Promise<boolean> {
  const trimmed = message.trim();

  // ── Add skill ─────────────────────────────────────────────────────
  const addMatch = trimmed.match(ADD_PATTERN);
  if (addMatch) {
    const skillName = addMatch[1]!;
    const result = await skillsRegistry.add(skillName);

    if (result.success) {
      const skills = await skillsRegistry.load();
      await ctx.reply(
        `✅ Added '<b>${escapeHtml(skillName)}</b>' to skills menu.\n\n` +
          `Current skills: ${skills.map((s) => `<code>${escapeHtml(s)}</code>`).join(", ")}\n\n` +
          `Use /skills to see updated buttons.`,
        { parse_mode: "HTML" }
      );
    } else {
      await ctx.reply(`⚠️ ${result.message}`);
    }
    return true;
  }

  // ── Remove skill ──────────────────────────────────────────────────
  const removeMatch = trimmed.match(REMOVE_PATTERN);
  if (removeMatch) {
    const skillName = removeMatch[1]!;
    const result = await skillsRegistry.remove(skillName);

    if (result.success) {
      const skills = await skillsRegistry.load();
      await ctx.reply(
        `✅ Removed '<b>${escapeHtml(skillName)}</b>' from skills menu.\n\n` +
          `Current skills: ${skills.length > 0 ? skills.map((s) => `<code>${escapeHtml(s)}</code>`).join(", ") : "<i>empty</i>"}\n\n` +
          `Use /skills to see updated buttons.`,
        { parse_mode: "HTML" }
      );
    } else {
      await ctx.reply(`⚠️ ${result.message}`);
    }
    return true;
  }

  // ── Show skills ───────────────────────────────────────────────────
  if (SHOW_PATTERN.test(trimmed)) {
    const skills = await skillsRegistry.sync();
    const available = await skillsRegistry.scan();

    await ctx.reply(
      `🛠️ <b>Skills Registry</b>\n\n` +
        `<b>Registered:</b> ${skills.length > 0 ? skills.map((s) => `<code>${s}</code>`).join(", ") : "<i>none</i>"}\n` +
        `<b>Available:</b> ${available.length > 0 ? available.map((s) => `<code>${s}</code>`).join(", ") : "<i>none</i>"}\n\n` +
        `Say "add {skill} to skills menu" or "remove {skill} from skills menu" to manage.`,
      { parse_mode: "HTML" }
    );
    return true;
  }

  // ── Reset skills ──────────────────────────────────────────────────
  if (RESET_PATTERN.test(trimmed)) {
    await skillsRegistry.reset();
    const skills = await skillsRegistry.load();
    await ctx.reply(
      `🔄 Skills menu reset to defaults.\n\n` +
        `Current skills: ${skills.map((s) => `<code>${escapeHtml(s)}</code>`).join(", ")}\n\n` +
        `Use /skills to see updated buttons.`,
      { parse_mode: "HTML" }
    );
    return true;
  }

  return false;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
