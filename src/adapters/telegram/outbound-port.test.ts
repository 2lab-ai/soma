import { describe, expect, test } from "bun:test";
import type { Context } from "grammy";
import { createTelegramOutboundPort } from "./outbound-port";

describe("createTelegramOutboundPort", () => {
  test("maps sendText and sendReaction to grammy api calls", async () => {
    const calls: Array<{
      method: "sendMessage" | "setMessageReaction";
      args: unknown[];
    }> = [];
    const ctx = {
      api: {
        sendMessage: async (chatId: number, text: string) => {
          calls.push({ method: "sendMessage", args: [chatId, text] });
          return { message_id: 321 };
        },
        setMessageReaction: async (
          chatId: number,
          messageId: number,
          reaction: unknown
        ) => {
          calls.push({
            method: "setMessageReaction",
            args: [chatId, messageId, reaction],
          });
        },
      },
    } as unknown as Context;

    const port = createTelegramOutboundPort(ctx);
    const messageId = await port.sendText(100, "hello");
    await port.sendReaction(100, 321, "👌");

    expect(messageId).toBe(321);
    expect(calls[0]).toEqual({
      method: "sendMessage",
      args: [100, "hello"],
    });
    expect(calls[1]).toEqual({
      method: "setMessageReaction",
      args: [100, 321, [{ type: "emoji", emoji: "👌" }]],
    });
  });
});
