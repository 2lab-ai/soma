import { afterEach, describe, expect, test } from "bun:test";
import type { Context } from "grammy";
import { handleNew, handleResume } from "./commands";
import { sessionManager } from "../session-manager";
import type { SteeringMessage } from "../types";

interface ReplyCall {
  text: string;
  options?: Record<string, unknown>;
}

function createCommandContext({
  userId = 1,
  chatId = 1001,
  threadId = 42,
}: {
  userId?: number;
  chatId?: number;
  threadId?: number;
} = {}): { ctx: Context; replies: ReplyCall[] } {
  const replies: ReplyCall[] = [];

  const ctx = {
    from: { id: userId },
    chat: { id: chatId, type: "private" },
    message: {
      message_thread_id: threadId,
    },
    api: {
      setMessageReaction: async () => {},
    },
    reply: async (text: string, options?: Record<string, unknown>) => {
      replies.push({ text, options });
      return {
        message_id: 777,
        chat: { id: chatId },
      };
    },
  } as unknown as Context;

  return { ctx, replies };
}

const originalSessionManagerMethods = {
  deriveKey: sessionManager.deriveKey,
  getSession: sessionManager.getSession,
  killSession: sessionManager.killSession,
  hasSession: sessionManager.hasSession,
};

function restoreSessionManagerMethods(): void {
  sessionManager.deriveKey = originalSessionManagerMethods.deriveKey;
  sessionManager.getSession = originalSessionManagerMethods.getSession;
  sessionManager.killSession = originalSessionManagerMethods.killSession;
  sessionManager.hasSession = originalSessionManagerMethods.hasSession;
}

describe("command handlers unit", () => {
  afterEach(() => {
    restoreSessionManagerMethods();
  });

  test("/new uses canonical deriveKey and wires lost-message recovery", async () => {
    const { ctx, replies } = createCommandContext({ chatId: 2002, threadId: 99 });

    const lostMessages: SteeringMessage[] = [
      {
        content: "recover me",
        messageId: 501,
        timestamp: Date.now(),
      },
    ];

    const pendingRecoveryCalls: Array<[SteeringMessage[], number, number?]> = [];
    const oldSession = {
      sessionId: "old-session-id",
    };
    const newSession = {
      sessionId: null,
      isActive: false,
      setPendingRecovery: (
        messages: SteeringMessage[],
        chatId: number,
        messageId?: number
      ) => {
        pendingRecoveryCalls.push([messages, chatId, messageId]);
      },
    };

    let deriveKeyArgs: [number, number?] | null = null;
    let getSessionCallCount = 0;

    sessionManager.deriveKey = ((chatId: number, threadId?: number) => {
      deriveKeyArgs = [chatId, threadId];
      return `default:${chatId}:${threadId ?? "main"}`;
    }) as typeof sessionManager.deriveKey;

    sessionManager.getSession = ((_chatId: number, _threadId?: number) => {
      getSessionCallCount += 1;
      if (getSessionCallCount === 1) {
        return oldSession as never;
      }
      return newSession as never;
    }) as typeof sessionManager.getSession;

    sessionManager.killSession = (async () => ({
      count: lostMessages.length,
      messages: lostMessages,
    })) as typeof sessionManager.killSession;

    await handleNew(ctx);

    expect(deriveKeyArgs).not.toBeNull();
    expect(deriveKeyArgs!).toEqual([2002, 99]);
    expect(pendingRecoveryCalls.length).toBe(2);
    expect(pendingRecoveryCalls[0]).toEqual([lostMessages, 2002, undefined]);
    expect(pendingRecoveryCalls[1]).toEqual([lostMessages, 2002, 777]);
    expect(replies.length).toBe(1);
    expect(replies[0]?.options?.parse_mode).toBe("Markdown");
  });

  test("/resume resumes canonical chat session when persisted state exists", async () => {
    const { ctx, replies } = createCommandContext({ chatId: 3003, threadId: 7 });

    sessionManager.getSession = (() =>
      ({
        isActive: false,
      }) as never) as typeof sessionManager.getSession;

    let hasSessionArgs: [number, number?] | null = null;
    sessionManager.hasSession = ((chatId: number, threadId?: number) => {
      hasSessionArgs = [chatId, threadId];
      return true;
    }) as typeof sessionManager.hasSession;

    await handleResume(ctx);

    expect(hasSessionArgs).not.toBeNull();
    expect(hasSessionArgs!).toEqual([3003, 7]);
    expect(replies.length).toBe(1);
    expect(replies[0]?.text).toContain("Session resumed for this chat");
  });

  test("/resume returns warning when session is already active", async () => {
    const { ctx, replies } = createCommandContext({ chatId: 4004, threadId: 1 });

    sessionManager.getSession = (() =>
      ({
        isActive: true,
      }) as never) as typeof sessionManager.getSession;

    let hasSessionCalled = false;
    sessionManager.hasSession = (() => {
      hasSessionCalled = true;
      return true;
    }) as typeof sessionManager.hasSession;

    await handleResume(ctx);

    expect(hasSessionCalled).toBe(false);
    expect(replies.length).toBe(1);
    expect(replies[0]?.text).toContain("Session already active");
  });
});
