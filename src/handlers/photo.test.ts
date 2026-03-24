import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync } from "fs";
import type { Context } from "grammy";
import { ALLOWED_USERS, TEMP_DIR } from "../config";
import { sessionManager } from "../core/session/session-manager";
import { rateLimiter } from "../security";
import { handlePhoto } from "./photo";

interface MockContextState {
  replies: string[];
  reactions: string[];
  deletedMessages: number[];
}

function createMockPhotoContext(messageId: number): {
  ctx: Context;
  state: MockContextState;
} {
  const state: MockContextState = {
    replies: [],
    reactions: [],
    deletedMessages: [],
  };

  const chatId = 12345;
  let replySeq = 900 + messageId;

  const ctx = {
    from: { id: TEST_USER_ID, username: "tester" },
    chat: { id: chatId, type: "private" },
    message: {
      message_id: messageId,
      message_thread_id: 1,
      photo: [{ file_id: `photo-${messageId}` }],
      date: 1_700_000_000,
    },
    api: {
      token: "telegram-test-token",
      deleteMessage: mock(async (_chatId: number, targetMessageId: number) => {
        state.deletedMessages.push(targetMessageId);
        return true;
      }),
      editMessageText: mock(async () => true),
    },
    getFile: mock(async () => ({ file_path: `photo-${messageId}.jpg` })),
    reply: mock(async (text: string) => {
      state.replies.push(text);
      return { chat: { id: chatId }, message_id: ++replySeq };
    }),
    react: mock(async (emoji: string) => {
      state.reactions.push(emoji);
    }),
    replyWithChatAction: mock(async () => true),
  } as unknown as Context;

  return { ctx, state };
}

const originalGetSession = sessionManager.getSession;
const originalRateLimitCheck = rateLimiter.check;
const originalFetch = globalThis.fetch;
const TEST_USER_ID = 1;

beforeAll(() => {
  mkdirSync(TEMP_DIR, { recursive: true });
  if (!ALLOWED_USERS.includes(TEST_USER_ID)) {
    ALLOWED_USERS.push(TEST_USER_ID);
  }
});

afterAll(() => {
  const idx = ALLOWED_USERS.indexOf(TEST_USER_ID);
  if (idx !== -1) ALLOWED_USERS.splice(idx, 1);
});

afterEach(() => {
  (sessionManager as unknown as { getSession: typeof originalGetSession }).getSession =
    originalGetSession;
  (rateLimiter as unknown as { check: typeof originalRateLimitCheck }).check =
    originalRateLimitCheck;
  globalThis.fetch = originalFetch;
});

describe("handlePhoto concurrency regression", () => {
  test("BUG soma-qivc: handlePhoto serializes concurrent single-photo requests", async () => {
    globalThis.fetch = mock(async () => ({
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    })) as unknown as typeof fetch;

    let queue: Promise<void> = Promise.resolve();
    let inFlight = false;
    const sendMessageStreaming = mock(async () => {
      if (inFlight) {
        throw new Error(
          "sendMessageStreaming is already running. Concurrent calls are not supported."
        );
      }
      inFlight = true;
      try {
        await Bun.sleep(25);
        return "ok";
      } finally {
        inFlight = false;
      }
    });

    const fakeSession = {
      runSerializedQuery: <T>(task: () => Promise<T> | T) => {
        const run = queue.then(() => task());
        queue = run.then(
          () => undefined,
          () => undefined
        );
        return run;
      },
      startProcessing: mock(() => () => {}),
      sendMessageStreaming,
    } as unknown as ReturnType<typeof sessionManager.getSession>;

    (sessionManager as unknown as { getSession: () => typeof fakeSession }).getSession =
      () => fakeSession;
    (rateLimiter as unknown as { check: typeof originalRateLimitCheck }).check =
      (() => [true, undefined]) as typeof originalRateLimitCheck;

    const first = createMockPhotoContext(101);
    const second = createMockPhotoContext(102);

    await Promise.all([handlePhoto(first.ctx), handlePhoto(second.ctx)]);

    expect(sendMessageStreaming).toHaveBeenCalledTimes(2);
    expect(fakeSession.startProcessing).toHaveBeenCalledTimes(2);
    expect(
      [...first.state.replies, ...second.state.replies].some((text) =>
        text.includes("already running")
      )
    ).toBe(false);
  });
});
