import { afterEach, describe, expect, test } from "bun:test";
import type { Context } from "grammy";
import { handleNew, handleResume } from "./commands";
import { formatDuration, formatTimeRemaining } from "./commands/formatters";
import { sessionManager } from "../core/session/session-manager";
import type { SteeringMessage } from "../types/session";

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

  test("formatters produce stable duration/time strings", () => {
    expect(formatDuration(9)).toBe("9s");
    expect(formatDuration(65)).toBe("1m 5s");
    expect(formatDuration(3661)).toBe("1h 1m 1s");

    expect(formatTimeRemaining(null)).toBe("");
    expect(formatTimeRemaining(Math.floor((Date.now() - 1_000) / 1000))).toBe("now");
    expect(
      formatTimeRemaining(
        Math.floor((Date.now() + (4 * 86_400 + 3 * 3_600 + 30) * 1_000) / 1_000)
      )
    ).toContain("4d");
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
