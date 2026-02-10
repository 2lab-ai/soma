import { describe, expect, test } from "bun:test";
import type { Context } from "grammy";
import {
  TelegramChannelBoundary,
  buildTelegramAgentRoute,
  isTelegramBoundaryError,
} from "./channel-boundary";
import type { ChannelOutboundPayload } from "../../channels/plugins/types.core";
import { ChannelOutboundOrchestrator } from "../../channels/outbound-orchestrator";
import type { TelegramAuthPolicy } from "./auth-policy";
import type { TelegramOrderPolicy } from "./order-policy";
import type { TelegramRateLimitPolicy } from "./rate-limit-policy";

function createContext({
  text = "hello",
  userId = 1,
  username = "tester",
  chatId = 100,
  chatType = "private",
  threadId,
  messageId = 10,
  timestampSeconds = 1700000000,
}: {
  text?: string;
  userId?: number;
  username?: string;
  chatId?: number;
  chatType?: string;
  threadId?: number;
  messageId?: number;
  timestampSeconds?: number;
} = {}): Context {
  return {
    from: {
      id: userId,
      username,
    },
    chat: {
      id: chatId,
      type: chatType,
    },
    message: {
      text,
      message_id: messageId,
      message_thread_id: threadId,
      date: timestampSeconds,
    },
  } as unknown as Context;
}

describe("TelegramChannelBoundary", () => {
  test("normalizes telegram inbound into common envelope", () => {
    const boundary = new TelegramChannelBoundary({
      authorize: () => true,
      checkRateLimit: () => [true],
    });

    const inbound = boundary.normalizeInbound({
      ctx: createContext({
        text: "! interrupt",
        threadId: 22,
        timestampSeconds: 1700000001,
      }),
      tenantId: "tenant-a",
    });

    expect(inbound.identity.tenantId as string).toBe("tenant-a");
    expect(inbound.identity.channelId as string).toBe("100");
    expect(inbound.identity.threadId as string).toBe("22");
    expect(inbound.identity.userId).toBe("1");
    expect(inbound.isInterrupt).toBe(true);
  });

  test("enforces auth at boundary entry", () => {
    const boundary = new TelegramChannelBoundary({
      authorize: () => false,
      checkRateLimit: () => [true],
    });

    try {
      boundary.normalizeInbound({ ctx: createContext() });
      throw new Error("Expected authorization failure");
    } catch (error) {
      expect(isTelegramBoundaryError(error)).toBe(true);
      expect((error as { code: string }).code).toBe("CHANNEL_UNAUTHORIZED");
    }
  });

  test("enforces inbound rate-limit at boundary entry", () => {
    const boundary = new TelegramChannelBoundary({
      authorize: () => true,
      checkRateLimit: () => [false, 3.5],
    });

    try {
      boundary.normalizeInbound({ ctx: createContext() });
      throw new Error("Expected rate limit failure");
    } catch (error) {
      expect(isTelegramBoundaryError(error)).toBe(true);
      expect((error as { code: string }).code).toBe("CHANNEL_RATE_LIMITED");
    }
  });

  test("drops out-of-order messages unless interrupt bypass applies", () => {
    const boundary = new TelegramChannelBoundary({
      authorize: () => true,
      checkRateLimit: () => [true],
    });

    boundary.normalizeInbound({
      ctx: createContext({ timestampSeconds: 2000, text: "newest" }),
    });

    expect(() =>
      boundary.normalizeInbound({
        ctx: createContext({ timestampSeconds: 1999, text: "older" }),
      })
    ).toThrow();

    const bypass = boundary.normalizeInbound({
      ctx: createContext({ timestampSeconds: 1998, text: "! stop older" }),
    });
    expect(bypass.metadata.interruptBypassApplied).toBe(true);
  });

  test("supports policy injection while preserving default envelope mapping", () => {
    const calls: { auth: number; rateLimit: number; order: number } = {
      auth: 0,
      rateLimit: 0,
      order: 0,
    };
    const authPolicy: TelegramAuthPolicy = {
      evaluate: () => {
        calls.auth += 1;
        return { authorized: true };
      },
    };
    const rateLimitPolicy: TelegramRateLimitPolicy = {
      evaluate: () => {
        calls.rateLimit += 1;
        return { allowed: true, retryAfterSeconds: 2.5 };
      },
    };
    const orderPolicy: TelegramOrderPolicy = {
      evaluate: () => {
        calls.order += 1;
        return { accepted: true, interruptBypassApplied: true };
      },
    };
    const boundary = new TelegramChannelBoundary({
      authPolicy,
      rateLimitPolicy,
      orderPolicy,
    });

    const inbound = boundary.normalizeInbound({
      ctx: createContext({ text: "hello policy", threadId: 99 }),
      tenantId: "tenant-policy",
    });

    expect(calls).toEqual({ auth: 1, rateLimit: 1, order: 1 });
    expect(inbound.identity.tenantId as string).toBe("tenant-policy");
    expect(inbound.metadata.retryAfterSeconds).toBe(2.5);
    expect(inbound.metadata.interruptBypassApplied).toBe(true);
  });

  test("delivers mixed outbound events through orchestrator + boundary", async () => {
    const sent: Array<{ type: "text" | "reaction"; text?: string; reaction?: string }> =
      [];
    const boundary = new TelegramChannelBoundary({
      authorize: () => true,
      checkRateLimit: () => [true],
      outboundPort: {
        sendText: async (_chatId, text) => {
          sent.push({ type: "text", text });
          return 77;
        },
        sendReaction: async (_chatId, _messageId, reaction) => {
          sent.push({ type: "reaction", reaction });
        },
      },
    });

    const inbound = boundary.normalizeInbound({
      ctx: createContext({ text: "hello", messageId: 123 }),
      tenantId: "tenant-a",
    });
    const route = buildTelegramAgentRoute(inbound);
    const orchestrator = new ChannelOutboundOrchestrator(boundary);

    const textPayload: ChannelOutboundPayload = {
      type: "text",
      route,
      text: "outbound text",
    };
    const reactionPayload: ChannelOutboundPayload = {
      type: "reaction",
      route,
      targetMessageId: inbound.identity.messageId,
      reaction: "👌",
    };

    const textReceipt = await orchestrator.dispatch(textPayload);
    const statusReceipt = await orchestrator.sendStatus(
      route,
      "working",
      "status text"
    );
    const choiceReceipt = await orchestrator.sendChoice(route, {
      question: "Pick one",
      choices: [{ id: "a", label: "A" }],
    });
    const reactionReceipt = await orchestrator.dispatch(reactionPayload);

    expect(textReceipt.messageId).toBe("77");
    expect(statusReceipt.messageId).toBe("77");
    expect(choiceReceipt.messageId).toBe("77");
    expect(reactionReceipt.messageId).toBe(inbound.identity.messageId);
    expect(sent.map((entry) => entry.type)).toEqual([
      "text",
      "text",
      "text",
      "reaction",
    ]);
    expect(sent[1]?.text).toBe("status text");
    expect(sent[2]?.text).toContain("Pick one");
  });
});
