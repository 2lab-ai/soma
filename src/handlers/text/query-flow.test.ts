import { describe, expect, mock, test } from "bun:test";
import type { Context } from "grammy";
import { Reactions } from "../../constants/reactions";
import { runQueryFlow } from "./query-flow";

interface MockContextState {
  replies: string[];
  reactions: string[];
}

function createMockContext(messageText: string): {
  ctx: Context;
  state: MockContextState;
} {
  const state: MockContextState = {
    replies: [],
    reactions: [],
  };

  const chatId = 1001;
  let messageSeq = 500;

  const ctx = {
    from: { id: 1, username: "tester" },
    chat: { id: chatId, type: "private" },
    message: {
      text: messageText,
      message_id: 10,
      date: 1_700_000_000,
    },
    api: {
      setMessageReaction: mock(async () => true),
      deleteMessage: mock(async () => true),
      editMessageText: mock(async () => true),
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
    // Keep typing loop suspended so tests do not wait for Bun.sleep(4000).
    replyWithChatAction: mock(() => new Promise<boolean>(() => {})),
  } as unknown as Context;

  return { ctx, state };
}

function createAuthFailingSession(error: Error): {
  session: unknown;
  stopProcessing: ReturnType<typeof mock>;
} {
  const stopProcessing = mock(() => {});
  const session = {
    lastMessage: "",
    needsSave: false,
    temporaryModelOverride: null,
    rateLimitState: {
      consecutiveFailures: 0,
      cooldownUntil: null,
      opusResetsAt: null,
    },
    startProcessing: mock(() => stopProcessing),
    sendMessageStreaming: mock(async () => {
      throw error;
    }),
    kill: mock(async () => {}),
    clearStopRequested: mock(() => {}),
    hasSteeringMessages: mock(() => false),
    getSteeringCount: mock(() => 0),
    restoreInjectedSteering: mock(() => 0),
    consumeSteering: mock(() => null),
  };

  return { session, stopProcessing };
}

describe("runQueryFlow auth failure handling", () => {
  test("shows /login guidance and cleans processing state on OAuth expiry", async () => {
    const authError = new Error(
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token."}}'
    );
    const { ctx, state } = createMockContext("hello");
    const { session, stopProcessing } = createAuthFailingSession(authError);

    const deliverInboundReaction = mock(async (reaction: string) => {
      state.reactions.push(reaction);
    });

    await runQueryFlow({
      ctx,
      session: session as Parameters<typeof runQueryFlow>[0]["session"],
      message: "hello",
      chatId: 1001,
      userId: 1,
      username: "tester",
      deliverInboundReaction,
    });

    expect(deliverInboundReaction).toHaveBeenCalledWith(Reactions.PROCESSING);
    expect(
      (session as { sendMessageStreaming: ReturnType<typeof mock> })
        .sendMessageStreaming
    ).toHaveBeenCalledTimes(1);
    expect((session as { kill: ReturnType<typeof mock> }).kill).toHaveBeenCalledTimes(
      1
    );
    expect(
      (session as { clearStopRequested: ReturnType<typeof mock> }).clearStopRequested
    ).toHaveBeenCalledTimes(1);
    expect(stopProcessing).toHaveBeenCalledTimes(1);
    expect(state.replies.some((text) => text.includes("/login"))).toBe(true);
  });
});
