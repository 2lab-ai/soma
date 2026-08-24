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
      // Keep the approved content in place. Replacing the body with a generic
      // "✅ 승인됨" would erase the only record of WHAT was authorized, which
      // is the half of the audit trail the chat log is supposed to hold.
      const header =
        answer === "allow"
          ? "✅ <b>승인됨</b> — 아래 내용 그대로 실행합니다."
          : "🚫 <b>거부됨</b> — 아래 도구를 실행하지 않습니다.";
      const text = `${header}\n\n${resolution.approved.body}`;
      try {
        await ctx.editMessageText(text, { parse_mode: "HTML" });
      } catch (error) {
        console.warn(
          `[PERMISSION] Failed to update prompt message (messageId: ${getCallbackMessageId(ctx)}):`,
          error
        );
        // Last resort: a plain-text receipt that still names the tool and the
        // input digest, rather than losing the decision record entirely.
        try {
          await ctx.editMessageText(
            `${answer === "allow" ? "✅ 승인됨" : "🚫 거부됨"} — ` +
              `${resolution.approved.toolName} · sha256:${resolution.approved.digest}`
          );
        } catch (fallbackError) {
          console.warn("[PERMISSION] Receipt fallback also failed:", fallbackError);
        }
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
