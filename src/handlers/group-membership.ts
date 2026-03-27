/**
 * Group Membership Handler for Telegram Bot.
 *
 * Handles my_chat_member events to auto-detect when the bot is
 * added to or removed from groups. Dynamically registers/unregisters
 * groups in GroupRegistry.
 *
 * Trace: docs/telegram-group-session/trace.md, Scenarios 1-3
 */

import type { Context } from "grammy";
import { ALLOWED_GROUPS, ALLOWED_USERS } from "../config";
import { groupRegistry } from "../core/group-registry";

/** Chat types that are considered groups. */
const GROUP_CHAT_TYPES = new Set(["group", "supergroup"]);

/**
 * Determine if a chat member status represents "in the group".
 * Handles the `restricted` status via Telegram's `is_member` flag.
 */
function isMemberStatus(member: { status: string; is_member?: boolean }): boolean {
  const { status } = member;
  if (status === "member" || status === "administrator" || status === "creator") {
    return true;
  }
  // `restricted` status: check is_member flag (Telegram supergroup feature)
  if (status === "restricted") {
    return member.is_member === true;
  }
  return false;
}

/**
 * Handle my_chat_member updates — bot added/removed from groups.
 *
 * Trace S1: Bot added → register if adder is ALLOWED_USER.
 * Trace S2: Bot added by unauthorized user → ignore.
 * Trace S3: Bot removed → unregister.
 */
export async function handleGroupMembership(ctx: Context): Promise<void> {
  const update = ctx.myChatMember;
  if (!update || !update.from) return;

  const chatId = update.chat.id;
  const chatType = update.chat.type;
  const adderId = update.from.id;

  // Guard: only handle group/supergroup events
  if (!GROUP_CHAT_TYPES.has(chatType)) {
    return;
  }

  const wasMember = isMemberStatus(update.old_chat_member);
  const isMember = isMemberStatus(update.new_chat_member);

  if (!wasMember && isMember) {
    await handleBotJoinedGroup(ctx, chatId, adderId);
  } else if (wasMember && !isMember) {
    handleBotLeftGroup(chatId);
  }
  // Other transitions (e.g., promoted within member state) are silently ignored.
}

/**
 * Handle bot being added to a group.
 * Trace S1, Section 3a: validate adder is ALLOWED_USER → register.
 * Trace S2, Section 3a: unauthorized adder → silent reject.
 *
 * Skips registration for groups already in static ALLOWED_GROUPS
 * to preserve their existing mention-based response behavior.
 */
async function handleBotJoinedGroup(
  ctx: Context,
  chatId: number,
  adderId: number
): Promise<void> {
  // Security gate: only ALLOWED_USERS can register groups
  if (!ALLOWED_USERS.includes(adderId)) {
    console.warn(
      `[GroupMembership] Unauthorized user ${adderId} added bot to group ${chatId}`
    );
    return;
  }

  // Skip registration for statically configured groups — preserve their
  // existing mention-based response policy (backward compatibility).
  if (ALLOWED_GROUPS.includes(chatId)) {
    console.log(
      `[GroupMembership] Bot added to static group ${chatId} — skipping dynamic registration`
    );
    return;
  }

  const isNew = groupRegistry.register(chatId);
  if (isNew) {
    console.log(
      `[GroupMembership] Bot added to group ${chatId} by user ${adderId}`
    );

    // Send welcome message
    try {
      await ctx.reply(
        "안녕하세요! 이 그룹에서 도움이 필요하시면 말씀해 주세요. 🤖"
      );
    } catch (error) {
      console.error(
        `[GroupMembership] Failed to send welcome to group ${chatId} (bot may lack send permission):`,
        error
      );
    }
  }
}

/**
 * Handle bot being removed from a group.
 * Trace S3, Section 3a: unregister group.
 */
function handleBotLeftGroup(chatId: number): void {
  const wasRegistered = groupRegistry.unregister(chatId);
  if (wasRegistered) {
    console.log(`[GroupMembership] Bot removed from group ${chatId}`);
  }
}
