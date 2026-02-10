import type { Context } from "grammy";

export interface TelegramOutboundPort {
  sendText(chatId: number, text: string): Promise<number>;
  sendReaction(chatId: number, messageId: number, reaction: string): Promise<void>;
}

export function createTelegramOutboundPort(ctx: Context): TelegramOutboundPort {
  return {
    sendText: async (chatId, text) => {
      const message = await ctx.api.sendMessage(chatId, text);
      return message.message_id;
    },
    sendReaction: async (chatId, messageId, reaction) => {
      await ctx.api.setMessageReaction(chatId, messageId, [
        {
          type: "emoji",
          emoji: reaction as never,
        },
      ]);
    },
  };
}
