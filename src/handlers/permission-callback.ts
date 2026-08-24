/**
 * Inline-keyboard answers for Agent SDK tool-permission prompts (issue #79).
 *
 * Callback data: `perm:{requestId}:a` (approve) | `perm:{requestId}:d` (deny).
 * Authorization is two-layered: `handleCallback` runs `isAuthorizedForChat`
 * first, then the broker re-checks the request-specific chat/user/message
 * binding here so a stale or foreign click can never answer someone else's
 * pending prompt.
 */
import type { Context } from "grammy";
import {
  permissionBroker,
  type PermissionAnswer,
  type TelegramPermissionBroker,
} from "../core/session/permission-broker";

function getCallbackMessageId(ctx: Context): number | undefined {
  return (ctx.callbackQuery?.message as { message_id?: number } | undefined)
    ?.message_id;
}

function parseAnswer(code: string | undefined): PermissionAnswer | null {
  if (code === "a") return "allow";
  if (code === "d") return "deny";
  return null;
}

export async function handlePermissionCallback(
  ctx: Context,
  callbackData: string,
  chatId: number,
  userId: number,
  broker: TelegramPermissionBroker = permissionBroker
): Promise<void> {
  const parts = callbackData.split(":");
  const requestId = parts[1];
  const answer = parseAnswer(parts[2]);

  if (parts.length !== 3 || !requestId || !answer) {
    await ctx.answerCallbackQuery({ text: "Invalid permission callback" });
    return;
  }

  // Claim atomically BEFORE any Telegram API call — a double tap or a racing
  // second click must not resolve the request twice.
  const resolution = broker.resolve(requestId, answer, {
    userId,
    chatId,
    messageId: getCallbackMessageId(ctx),
  });

  switch (resolution.status) {
    case "resolved": {
      await ctx.answerCallbackQuery({
        text: answer === "allow" ? "승인됨" : "거부됨",
      });
      const text =
        answer === "allow"
          ? "✅ 승인됨 — Claude가 이어서 실행합니다."
          : "🚫 거부됨 — 도구를 실행하지 않습니다.";
      try {
        await ctx.editMessageText(text);
      } catch (error) {
        console.warn(
          `[PERMISSION] Failed to update prompt message (messageId: ${getCallbackMessageId(ctx)}):`,
          error
        );
      }
      return;
    }

    case "forbidden":
      await ctx.answerCallbackQuery({
        text: "이 요청에 응답할 권한이 없습니다",
      });
      return;

    case "stale":
      await ctx.answerCallbackQuery({
        text: "이 요청은 새로운 요청으로 대체되었습니다",
      });
      return;

    case "unknown":
      await ctx.answerCallbackQuery({
        text: "이미 처리되었거나 만료된 요청입니다",
      });
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      } catch (error) {
        console.warn("[PERMISSION] Failed to remove stale keyboard:", error);
      }
      return;
  }
}
