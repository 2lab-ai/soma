/**
 * Tests: media/direct-input entrypoints bind the querying Telegram user
 * (issue #79).
 *
 * `sendMessageStreaming(prompt, cb, { chatId, userId, modelContext })` — the
 * context object's `userId` is what binds a permission prompt to a specific
 * user. Photo, voice and document handlers passed only `chatId`, so in a GROUP
 * (where chat id !== user id) the prompt fell back to chat-level
 * authorization: any authorized member could answer another member's prompt.
 *
 * `userId` is a REQUIRED property (PR #80 review): omitting the actor is a
 * compile-time error, not a silent downgrade.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync } from "fs";
import type { Context } from "grammy";
import { ALLOWED_GROUPS, ALLOWED_USERS, TEMP_DIR } from "../config";
import { sessionManager } from "../core/session/session-manager";
import { rateLimiter } from "../security";
import type { ClaudeSession } from "../core/session/session";
import type { QueryContext } from "../types/runtime";
import { handlePhoto } from "./photo";
import { handleDocument } from "./document";
import { botUsername } from "./text";
import { handlePendingDirectInput } from "./text/direct-input-flow";

// Group chat: chat id !== user id, which is exactly where a chat-only
// binding stops being a user binding.
const GROUP_CHAT_ID = -1009900001;
const TEST_USER_ID = 990101;

const originalGetSession = sessionManager.getSession;
const originalRateLimitCheck = rateLimiter.check;
const originalFetch = globalThis.fetch;

beforeAll(() => {
  mkdirSync(TEMP_DIR, { recursive: true });
  if (!ALLOWED_USERS.includes(TEST_USER_ID)) {
    ALLOWED_USERS.push(TEST_USER_ID);
  }
  // Static allowed group: any allowed user may talk to the bot there.
  if (!ALLOWED_GROUPS.includes(GROUP_CHAT_ID)) {
    ALLOWED_GROUPS.push(GROUP_CHAT_ID);
  }
});

afterAll(() => {
  const userIdx = ALLOWED_USERS.indexOf(TEST_USER_ID);
  if (userIdx !== -1) ALLOWED_USERS.splice(userIdx, 1);
  const groupIdx = ALLOWED_GROUPS.indexOf(GROUP_CHAT_ID);
  if (groupIdx !== -1) ALLOWED_GROUPS.splice(groupIdx, 1);
});

afterEach(() => {
  (sessionManager as unknown as { getSession: typeof originalGetSession }).getSession =
    originalGetSession;
  (rateLimiter as unknown as { check: typeof originalRateLimitCheck }).check =
    originalRateLimitCheck;
  globalThis.fetch = originalFetch;
});

/** Full arity so `.mock.calls[n][2]` (the query context) is typed and observable. */
function makeSendMessageStreamingMock() {
  return mock(
    async (prompt: string, _statusCallback: unknown, _context: QueryContext) => prompt
  );
}

function installFakeSession(): ReturnType<typeof makeSendMessageStreamingMock> {
  let queue: Promise<void> = Promise.resolve();
  const sendMessageStreaming = makeSendMessageStreamingMock();

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
  (rateLimiter as unknown as { check: typeof originalRateLimitCheck }).check = (() => [
    true,
    undefined,
  ]) as typeof originalRateLimitCheck;

  return sendMessageStreaming;
}

function stubFileDownload(): void {
  // A 1x1 PNG — photo/document handlers sniff magic bytes before sending.
  const pngBytes = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    ),
    (char) => char.charCodeAt(0)
  );
  globalThis.fetch = mock(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: async () => pngBytes.buffer,
  })) as unknown as typeof fetch;
}

function makeGroupContext(
  messageId: number,
  message: Record<string, unknown>
): Context {
  return {
    from: { id: TEST_USER_ID, username: "tester" },
    chat: { id: GROUP_CHAT_ID, type: "group" },
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      // Reply to the bot — the mention-free way to address it in a static
      // allowed group, and independent of whatever `botUsername` happens to
      // be at this point in the run.
      reply_to_message: {
        message_id: messageId - 1,
        from: { id: 42, is_bot: true, username: botUsername },
      },
      ...message,
    },
    api: {
      token: "telegram-test-token",
      deleteMessage: mock(async () => true),
      editMessageText: mock(async () => true),
    },
    getFile: mock(async () => ({ file_path: `file-${messageId}.bin` })),
    reply: mock(async () => ({
      chat: { id: GROUP_CHAT_ID },
      message_id: 5000 + messageId,
    })),
    react: mock(async () => true),
    replyWithChatAction: mock(async () => true),
  } as unknown as Context;
}

describe("media entrypoints bind the querying user", () => {
  test("handlePhoto forwards ctx.from.id as queryUserId", async () => {
    stubFileDownload();
    const sendMessageStreaming = installFakeSession();

    // Group chats require a mention; a caption addressed to the bot is the
    // simplest trigger that also exercises the caption prompt path.
    const ctx = makeGroupContext(301, {
      photo: [{ file_id: "photo-301" }],
      caption: "look at this",
    });

    await handlePhoto(ctx);

    expect(sendMessageStreaming).toHaveBeenCalledTimes(1);
    expect(sendMessageStreaming.mock.calls[0]?.[2]?.chatId).toBe(GROUP_CHAT_ID);
    expect(sendMessageStreaming.mock.calls[0]?.[2]?.userId).toBe(TEST_USER_ID);
  });

  test("handleDocument forwards ctx.from.id as queryUserId", async () => {
    stubFileDownload();
    const sendMessageStreaming = installFakeSession();

    const ctx = makeGroupContext(302, {
      caption: "check this",
      document: {
        file_name: "image.png",
        mime_type: "image/png",
        file_size: 1024,
      },
    });

    await handleDocument(ctx);

    expect(sendMessageStreaming).toHaveBeenCalledTimes(1);
    expect(sendMessageStreaming.mock.calls[0]?.[2]?.chatId).toBe(GROUP_CHAT_ID);
    expect(sendMessageStreaming.mock.calls[0]?.[2]?.userId).toBe(TEST_USER_ID);
  });

  test("handleVoice forwards ctx.from.id as queryUserId", async () => {
    // Stub the STT hop (ffmpeg + HTTP) — this test is about the binding.
    mock.module("../utils/voice", () => ({
      transcribeVoice: async () => "transcribed words",
    }));
    const { handleVoice } = await import("./voice");

    stubFileDownload();
    const sendMessageStreaming = installFakeSession();

    const ctx = makeGroupContext(304, {
      voice: { file_id: "voice-304", duration: 2 },
    });

    await handleVoice(ctx);

    expect(sendMessageStreaming).toHaveBeenCalledTimes(1);
    expect(sendMessageStreaming.mock.calls[0]?.[2]?.chatId).toBe(GROUP_CHAT_ID);
    expect(sendMessageStreaming.mock.calls[0]?.[2]?.userId).toBe(TEST_USER_ID);
  });

  test("handlePendingDirectInput forwards the answering user as queryUserId", async () => {
    (rateLimiter as unknown as { check: typeof originalRateLimitCheck }).check =
      (() => [true, undefined]) as typeof originalRateLimitCheck;

    const sendMessageStreaming = makeSendMessageStreamingMock();
    const session = {
      pendingDirectInput: {
        type: "single" as const,
        messageId: 4242,
        createdAt: Date.now(),
      },
      choiceState: null,
      isProcessing: false,
      clearDirectInput: mock(() => {}),
      clearChoiceState: mock(() => {}),
      setActivityState: mock(() => {}),
      sendMessageStreaming,
    } as unknown as ClaudeSession;

    const ctx = makeGroupContext(303, { text: "my typed answer" });

    await handlePendingDirectInput({
      ctx,
      session,
      chatId: GROUP_CHAT_ID,
      message: "my typed answer",
      username: "tester",
      userId: TEST_USER_ID,
    });

    expect(sendMessageStreaming).toHaveBeenCalledTimes(1);
    expect(sendMessageStreaming.mock.calls[0]?.[2]?.chatId).toBe(GROUP_CHAT_ID);
    expect(sendMessageStreaming.mock.calls[0]?.[2]?.userId).toBe(TEST_USER_ID);
  });
});
