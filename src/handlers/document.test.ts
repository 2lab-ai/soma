import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdirSync } from "fs";
import type { Context } from "grammy";
import { ALLOWED_USERS, TEMP_DIR } from "../config";
import { sessionManager } from "../core/session/session-manager";
import { rateLimiter } from "../security";
import { handleDocument, isImageDocumentType } from "./document";

interface MockContextState {
  replies: string[];
  reactions: string[];
}

function createMockDocumentContext(
  messageId: number,
  fileName: string,
  mimeType: string
): {
  ctx: Context;
  state: MockContextState;
} {
  const state: MockContextState = {
    replies: [],
    reactions: [],
  };

  const chatId = 12345;
  let replySeq = 1200 + messageId;

  const ctx = {
    from: { id: TEST_USER_ID, username: "tester" },
    chat: { id: chatId, type: "private" },
    message: {
      message_id: messageId,
      message_thread_id: 1,
      caption: undefined,
      document: {
        file_name: fileName,
        mime_type: mimeType,
        file_size: 1024,
      },
      date: 1_700_000_000,
    },
    api: {
      token: "telegram-test-token",
      deleteMessage: mock(async () => true),
      editMessageText: mock(async () => true),
    },
    getFile: mock(async () => ({ file_path: fileName })),
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

describe("handleDocument image regression", () => {
  test("BUG soma-es0c: isImageDocumentType accepts requested image document formats", () => {
    expect(isImageDocumentType("image.png", "image/png")).toBe(true);
    expect(isImageDocumentType("image.jpg")).toBe(true);
    expect(isImageDocumentType("image.jpeg")).toBe(true);
    expect(isImageDocumentType("image.webp")).toBe(true);
    expect(isImageDocumentType("vector.svg", "image/svg+xml")).toBe(true);
    expect(isImageDocumentType("report.pdf", "application/pdf")).toBe(false);
  });

  test("BUG soma-es0c: handleDocument accepts png image documents", async () => {
    globalThis.fetch = mock(async () => ({
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    })) as unknown as typeof fetch;

    let queue: Promise<void> = Promise.resolve();
    const sendMessageStreaming = mock(async (prompt: string) => {
      await Bun.sleep(10);
      return prompt;
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

    const { ctx, state } = createMockDocumentContext(201, "image.png", "image/png");

    await handleDocument(ctx);

    expect(sendMessageStreaming).toHaveBeenCalledTimes(1);
    expect(sendMessageStreaming.mock.calls[0]?.[0]).toContain("Please analyze this image:");
    expect(
      state.replies.some((text) => text.includes("Unsupported file type"))
    ).toBe(false);
  });
});
