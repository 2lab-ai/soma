import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Context } from "grammy";
import { sessionManager } from "../core/session/session-manager";
import { rateLimiter } from "../security";
import { handleText, setBotUsername } from "./text";

interface MockContextState {
  replies: string[];
  editedTexts: string[];
  reactions: string[];
  chatActions: string[];
}

function createMockContext(messageText: string): {
  ctx: Context;
  state: MockContextState;
} {
  const state: MockContextState = {
    replies: [],
    editedTexts: [],
    reactions: [],
    chatActions: [],
  };

  const chatId = 12345;
  let messageSeq = 700;

  const ctx = {
    from: { id: 1, username: "tester" },
    chat: { id: chatId, type: "private" },
    message: {
      text: messageText,
      message_id: 100,
      message_thread_id: 1,
      date: 1_700_000_000,
    },
    api: {
      setMessageReaction: mock(
        async (
          _chat: number,
          _messageId: number,
          reactions: Array<{ emoji?: string }>
        ) => {
          const reaction = reactions[0]?.emoji;
          if (reaction) state.reactions.push(reaction);
          return true;
        }
      ),
      editMessageText: mock(async (_chat: number, _messageId: number, text: string) => {
        state.editedTexts.push(text);
        return true;
      }),
      deleteMessage: mock(async () => true),
      sendMessage: mock(async (_chat: number, text: string) => {
        state.replies.push(text);
        return { chat: { id: chatId }, message_id: ++messageSeq };
      }),
    },
    reply: mock(async (text: string) => {
      state.replies.push(text);
      return { chat: { id: chatId }, message_id: ++messageSeq };
    }),
    react: mock(async (emoji: string) => {
      state.reactions.push(emoji);
    }),
    replyWithChatAction: mock(async (action: string) => {
      state.chatActions.push(action);
      return true;
    }),
  } as unknown as Context;

  return { ctx, state };
}

const originalGetSession = sessionManager.getSession;
const originalRateLimitCheck = rateLimiter.check;

afterEach(() => {
  (sessionManager as unknown as { getSession: typeof originalGetSession }).getSession =
    originalGetSession;
  (rateLimiter as unknown as { check: typeof originalRateLimitCheck }).check =
    originalRateLimitCheck;
  setBotUsername("");
});

describe("handleText refactor regression", () => {
  test("handles direct input single-choice flow and forwards answer to session", async () => {
    setBotUsername("soma_bot");

    let receivedPrompt: string | null = null;
    const sendMessageStreaming = mock(async (prompt: string) => {
      receivedPrompt = prompt;
      return "ok";
    });
    const fakeSession = {
      pendingDirectInput: {
        type: "single",
        messageId: 555,
        createdAt: Date.now(),
      },
      parseTextChoiceState: null,
      isProcessing: false,
      isRunning: false,
      clearDirectInput: mock(function () {
        fakeSession.pendingDirectInput = null;
      }),
      clearChoiceState: mock(() => {}),
      setActivityState: mock(() => {}),
      sendMessageStreaming,
      hasPendingRecovery: mock(() => false),
      startInterrupt: mock(() => true),
      markInterrupt: mock(() => {}),
      stop: mock(async () => false),
      clearStopRequested: mock(() => {}),
      endInterrupt: mock(() => {}),
      extractSteeringMessages: mock(() => []),
    } as unknown as ReturnType<typeof sessionManager.getSession>;

    (sessionManager as unknown as { getSession: () => typeof fakeSession }).getSession =
      () => fakeSession;

    const { ctx, state } = createMockContext("send this directly");
    await handleText(ctx);

    expect(sendMessageStreaming).toHaveBeenCalledTimes(1);
    expect(receivedPrompt ?? "").toBe("send this directly");
    expect(
      state.editedTexts.some((text) => text.includes("✓ send this directly"))
    ).toBe(true);
  });

  test("treats bang-only message as interrupt and sends stopped feedback", async () => {
    setBotUsername("soma_bot");

    const fakeSession = {
      pendingDirectInput: null,
      parseTextChoiceState: null,
      isProcessing: false,
      isRunning: true,
      isInterrupting: false,
      startInterrupt: mock(() => true),
      markInterrupt: mock(() => {}),
      stop: mock(async () => "stopped" as const),
      clearStopRequested: mock(() => {}),
      endInterrupt: mock(() => {}),
      extractSteeringMessages: mock(() => []),
      hasPendingRecovery: mock(() => false),
    } as unknown as ReturnType<typeof sessionManager.getSession>;

    (sessionManager as unknown as { getSession: () => typeof fakeSession }).getSession =
      () => fakeSession;

    const { ctx, state } = createMockContext("!");
    await handleText(ctx);

    expect(fakeSession.stop).toHaveBeenCalledTimes(1);
    expect(state.replies.some((text) => text.includes("Stopped"))).toBe(true);
  });

  test("maps boundary rate-limit failures to user-visible retry message", async () => {
    setBotUsername("soma_bot");

    const getSessionSpy = mock(() => {
      throw new Error("getSession should not be called on boundary rate-limit");
    });
    (sessionManager as unknown as { getSession: typeof getSessionSpy }).getSession =
      getSessionSpy;

    (rateLimiter as unknown as { check: typeof originalRateLimitCheck }).check =
      (() => [false, 2.5]) as typeof originalRateLimitCheck;

    const { ctx, state } = createMockContext("hello");
    await handleText(ctx);

    expect(getSessionSpy).toHaveBeenCalledTimes(0);
    expect(state.replies.some((text) => text.includes("Rate limited"))).toBe(true);
  });
});
