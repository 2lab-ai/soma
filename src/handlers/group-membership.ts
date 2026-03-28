/**
 * Group Membership Handler for Telegram Bot.
 *
 * Handles my_chat_member events. On bot join: sends DM to owner for confirmation
 * instead of auto-registering. On bot leave: unregisters group.
 *
 * Trace: docs/group-owner-confirm/trace.md, Scenarios 1, 3
 */

import { InlineKeyboard, type Context } from "grammy";
import { ALLOWED_GROUPS, ALLOWED_USERS } from "../config";
import { groupRegistry } from "../core/group-registry";
import { pendingGroupStore } from "../core/pending-group-store";

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
  if (status === "restricted") {
    return member.is_member === true;
  }
  return false;
}

/**
 * Handle my_chat_member updates — bot added/removed from groups.
 *
 * Trace S1: Bot added → send DM to owner for confirmation.
 * Trace S3: Bot removed → unregister.
 */
export async function handleGroupMembership(ctx: Context): Promise<void> {
  const update = ctx.myChatMember;
  if (!update || !update.from) return;

  const chatId = update.chat.id;
  const chatType = update.chat.type;
  const adderId = update.from.id;

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
}

/**
 * Handle bot being added to a group.
 * Trace S1: Instead of auto-register, send DM to owner for confirmation.
 */
async function handleBotJoinedGroup(
  ctx: Context,
  chatId: number,
  adderId: number
): Promise<void> {
  // Security gate: only ALLOWED_USERS can trigger the flow
  if (!ALLOWED_USERS.includes(adderId)) {
    console.warn(
      `[GroupMembership] Unauthorized user ${adderId} added bot to group ${chatId}`
    );
    return;
  }

  // Static groups: skip (backward compatibility)
  if (ALLOWED_GROUPS.includes(chatId)) {
    console.log(
      `[GroupMembership] Bot added to static group ${chatId} — skipping confirmation flow`
    );
    return;
  }

  // Already registered: skip
  if (groupRegistry.isRegistered(chatId)) {
    console.log(
      `[GroupMembership] Group ${chatId} already registered — skipping`
    );
    return;
  }

  const ownerId = ALLOWED_USERS[0]!;
  const chatTitle =
    (ctx.myChatMember?.chat as { title?: string })?.title || `Group ${chatId}`;

  // Build confirmation keyboard
  const keyboard = new InlineKeyboard()
    .text("✅ 활성화", `grp:${chatId}:accept`)
    .text("❌ 거부", `grp:${chatId}:reject`);

  // Send DM to owner
  let dmMessageId = 0;
  try {
    const dmMessage = await ctx.api.sendMessage(
      ownerId,
      `🔔 <b>그룹 활성화 요청</b>\n\n` +
        `그룹: <b>${escapeHtml(chatTitle)}</b>\n` +
        `그룹 ID: <code>${chatId}</code>\n` +
        `추가한 사용자: <code>${adderId}</code>\n\n` +
        `이 그룹에서 봇을 활성화하시겠습니까?`,
      { parse_mode: "HTML", reply_markup: keyboard }
    );
    dmMessageId = dmMessage.message_id;
  } catch (error) {
    console.error(
      `[GroupMembership] Failed to send DM to owner ${ownerId} for group ${chatId}:`,
      error
    );
    return;
  }

  // Store pending confirmation (rollback-safe)
  const stored = pendingGroupStore.add({
    chatId,
    chatTitle,
    adderId,
    ownerId,
    dmMessageId,
    createdAt: Date.now(),
  });
  if (!stored) {
    console.error(
      `[GroupMembership] Failed to persist pending confirmation for group ${chatId}`
    );
  }

  console.log(
    `[GroupMembership] Pending confirmation sent for group ${chatId} to owner ${ownerId}`
  );

  // Send waiting message to group
  try {
    await ctx.reply("⏳ 오너 확인을 기다리는 중입니다...");
  } catch (error) {
    console.error(
      `[GroupMembership] Failed to send waiting message to group ${chatId}:`,
      error
    );
  }
}

/**
 * Handle bot being removed from a group.
 */
function handleBotLeftGroup(chatId: number): void {
  const wasRegistered = groupRegistry.unregister(chatId);
  if (wasRegistered) {
    console.log(`[GroupMembership] Bot removed from group ${chatId}`);
  }
  // Also clean up any pending confirmation
  pendingGroupStore.remove(chatId);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
