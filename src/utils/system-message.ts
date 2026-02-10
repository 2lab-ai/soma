import type { Api } from "grammy";
import type { Context } from "grammy";
import { SYS_MSG_PREFIX } from "../config";

const SYSTEM_REACTION = "⚡";

interface ApiTarget {
  api: Api;
  chatId: number;
}

function isApiTarget(target: ApiTarget | Context): target is ApiTarget {
  return "chatId" in target && typeof (target as ApiTarget).chatId === "number";
}

export async function sendSystemMessage(
  target: ApiTarget | Context,
  text: string,
  options?: { parse_mode?: "HTML" | "Markdown" | "MarkdownV2" }
): Promise<number | null> {
  const fullText = text.startsWith(SYS_MSG_PREFIX) ? text : `${SYS_MSG_PREFIX} ${text}`;

  try {
    let msg: { message_id: number; chat: { id: number } };
    let api: Api;

    if (isApiTarget(target)) {
      msg = await target.api.sendMessage(target.chatId, fullText, options as any);
      api = target.api;
    } else {
      msg = await target.reply(fullText, options as any);
      api = target.api;
    }

    api
      .setMessageReaction(msg.chat.id, msg.message_id, [
        { type: "emoji", emoji: SYSTEM_REACTION },
      ])
      .catch((err) => {
        console.debug(
          `[SYS-MSG] Reaction failed for msg ${msg.message_id}:`,
          String(err).slice(0, 200)
        );
      });

    return msg.message_id;
  } catch {
    return null;
  }
}

export async function addSystemReaction(
  api: Api,
  chatId: number,
  messageId: number
): Promise<void> {
  try {
    await api.setMessageReaction(chatId, messageId, [
      { type: "emoji", emoji: SYSTEM_REACTION },
    ]);
  } catch (err) {
    console.debug(
      `[SYS-MSG] addSystemReaction failed for msg ${messageId}:`,
      String(err).slice(0, 200)
    );
  }
}
