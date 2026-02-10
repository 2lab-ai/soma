import { describe, test, expect, mock } from "bun:test";
import { sendSystemMessage, addSystemReaction } from "./system-message";

function createMockApi() {
  const sent: Array<{ chatId: number; text: string; opts?: any }> = [];
  const reactions: Array<{ chatId: number; msgId: number; emoji: string }> = [];

  return {
    sent,
    reactions,
    api: {
      sendMessage: mock(async (chatId: number, text: string, opts?: any) => {
        sent.push({ chatId, text, opts });
        return { message_id: 42, chat: { id: chatId } };
      }),
      setMessageReaction: mock(
        async (chatId: number, msgId: number, reaction: any[]) => {
          reactions.push({ chatId, msgId, emoji: reaction[0]?.emoji });
          return true;
        }
      ),
    },
  };
}

function createMockCtx() {
  const replied: Array<{ text: string; opts?: any }> = [];
  const reactions: Array<{ chatId: number; msgId: number; emoji: string }> = [];

  const api = {
    setMessageReaction: mock(async (chatId: number, msgId: number, reaction: any[]) => {
      reactions.push({ chatId, msgId, emoji: reaction[0]?.emoji });
      return true;
    }),
  };

  return {
    replied,
    reactions,
    ctx: {
      api,
      reply: mock(async (text: string, opts?: any) => {
        replied.push({ text, opts });
        return { message_id: 99, chat: { id: 123 } };
      }),
    },
  };
}

describe("sendSystemMessage", () => {
  test("sends message with SYS_MSG_PREFIX via api+chatId", async () => {
    const { api, sent } = createMockApi();
    const msgId = await sendSystemMessage({ api: api as any, chatId: 123 }, "Test msg");

    expect(msgId).toBe(42);
    expect(sent.length).toBe(1);
    expect(sent[0]!.text).toBe("⚡️ Test msg");
    expect(sent[0]!.chatId).toBe(123);
  });

  test("sends message via ctx.reply", async () => {
    const { ctx, replied } = createMockCtx();
    const msgId = await sendSystemMessage(ctx as any, "Test msg");

    expect(msgId).toBe(99);
    expect(replied.length).toBe(1);
    expect(replied[0]!.text).toBe("⚡️ Test msg");
  });

  test("does not double-prefix if already has SYS_MSG_PREFIX", async () => {
    const { api, sent } = createMockApi();
    await sendSystemMessage({ api: api as any, chatId: 123 }, "⚡️ Already prefixed");

    expect(sent[0]!.text).toBe("⚡️ Already prefixed");
  });

  test("adds ⚡ reaction to sent message", async () => {
    const { api, reactions } = createMockApi();
    await sendSystemMessage({ api: api as any, chatId: 123 }, "Test");

    await new Promise((r) => setTimeout(r, 50));
    expect(reactions.length).toBe(1);
    expect(reactions[0]!.emoji).toBe("⚡");
    expect(reactions[0]!.msgId).toBe(42);
  });

  test("adds ⚡ reaction via ctx path", async () => {
    const { ctx, reactions } = createMockCtx();
    await sendSystemMessage(ctx as any, "Test");

    await new Promise((r) => setTimeout(r, 50));
    expect(reactions.length).toBe(1);
    expect(reactions[0]!.emoji).toBe("⚡");
  });

  test("passes parse_mode option through", async () => {
    const { api, sent } = createMockApi();
    await sendSystemMessage({ api: api as any, chatId: 123 }, "**Bold**", {
      parse_mode: "Markdown",
    });

    expect(sent[0]!.opts).toEqual({ parse_mode: "Markdown" });
  });

  test("returns null on send failure", async () => {
    const failApi = {
      sendMessage: mock(async () => {
        throw new Error("Network error");
      }),
      setMessageReaction: mock(async () => true),
    };

    const result = await sendSystemMessage(
      { api: failApi as any, chatId: 123 },
      "Test"
    );
    expect(result).toBeNull();
  });
});

describe("addSystemReaction", () => {
  test("adds ⚡ reaction to message", async () => {
    const { api, reactions } = createMockApi();
    await addSystemReaction(api as any, 123, 456);

    expect(reactions.length).toBe(1);
    expect(reactions[0]!.chatId).toBe(123);
    expect(reactions[0]!.msgId).toBe(456);
    expect(reactions[0]!.emoji).toBe("⚡");
  });

  test("does not throw on failure", async () => {
    const failApi = {
      setMessageReaction: mock(async () => {
        throw new Error("Failed");
      }),
    };

    await addSystemReaction(failApi as any, 123, 456);
  });
});
