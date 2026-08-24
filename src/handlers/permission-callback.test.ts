/**
 * Tests: Telegram inline-keyboard answers for SDK permission prompts (issue #79).
 *
 * Mocked grammY Context + a real TelegramPermissionBroker, so an approve click
 * really settles the `canUseTool` Promise the blocked query is waiting on.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Context } from "grammy";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { ALLOWED_USERS } from "../config";
import {
  TelegramPermissionBroker,
  type PermissionPrompt,
} from "../core/session/permission-broker";
import { handlePermissionCallback } from "./permission-callback";

// Private chat: chat id === user id. A dedicated id (not the env-provided
// one) keeps the allowlist injection below independent of run order.
const CHAT_ID = 990001;
const USER_ID = 990001;
const MESSAGE_ID = 777;

// Inject the test userId into ALLOWED_USERS so isAuthorizedForChat passes.
beforeAll(() => {
  if (!ALLOWED_USERS.includes(USER_ID)) {
    ALLOWED_USERS.push(USER_ID);
  }
});

afterAll(() => {
  const idx = ALLOWED_USERS.indexOf(USER_ID);
  if (idx !== -1) ALLOWED_USERS.splice(idx, 1);
});

interface MockContext {
  ctx: Context;
  answers: Array<{ text?: string } | undefined>;
  edits: string[];
}

/** `null` = a callback_query with no `message` attached at all. */
function makeContext(messageId: number | null = MESSAGE_ID): MockContext {
  const answers: Array<{ text?: string } | undefined> = [];
  const edits: string[] = [];
  const ctx = {
    callbackQuery: {
      data: "",
      message: messageId === null ? undefined : { message_id: messageId },
    },
    answerCallbackQuery: async (payload?: { text?: string }) => {
      answers.push(payload);
      return true;
    },
    editMessageText: async (text: string) => {
      edits.push(text);
      return true;
    },
    editMessageReplyMarkup: async () => true,
  } as unknown as Context;

  return { ctx, answers, edits };
}

function makeBroker(): {
  broker: TelegramPermissionBroker;
  prompts: PermissionPrompt[];
} {
  const prompts: PermissionPrompt[] = [];
  const broker = new TelegramPermissionBroker({
    timeoutMs: 60_000,
    sendPrompt: async (prompt) => {
      prompts.push(prompt);
      return MESSAGE_ID;
    },
  });
  return { broker, prompts };
}

async function ask(
  broker: TelegramPermissionBroker,
  prompts: PermissionPrompt[]
): Promise<{
  pending: ReturnType<CanUseTool>;
  prompt: PermissionPrompt;
  input: Record<string, unknown>;
}> {
  const canUseTool = broker.createCanUseTool({
    chatId: CHAT_ID,
    userId: USER_ID,
    sessionKey: `default:${CHAT_ID}:main`,
  });
  const input = { command: "echo hi" };
  const pending = canUseTool("Bash", input, {
    signal: new AbortController().signal,
    toolUseID: "toolu_1",
  });
  for (let i = 0; i < 50 && prompts.length === 0; i++) {
    await Bun.sleep(1);
  }
  const prompt = prompts[0];
  if (!prompt) throw new Error("no permission prompt was sent");
  return { pending, prompt, input };
}

describe("handlePermissionCallback", () => {
  test("approve click resumes the blocked query with allow + original input", async () => {
    const { broker, prompts } = makeBroker();
    const { pending, prompt, input } = await ask(broker, prompts);
    const mock = makeContext();

    await handlePermissionCallback(
      mock.ctx,
      prompt.approveData,
      CHAT_ID,
      USER_ID,
      broker
    );

    const result = await pending;
    expect(result.behavior).toBe("allow");
    if (result.behavior !== "allow") throw new Error("expected allow");
    expect(result.updatedInput).toEqual(input);
    expect(mock.answers).toHaveLength(1);
    expect(mock.edits).toHaveLength(1);
    expect(mock.edits[0]).toContain("승인");
  });

  test("deny click resumes the blocked query with deny", async () => {
    const { broker, prompts } = makeBroker();
    const { pending, prompt } = await ask(broker, prompts);
    const mock = makeContext();

    await handlePermissionCallback(mock.ctx, prompt.denyData, CHAT_ID, USER_ID, broker);

    const result = await pending;
    expect(result.behavior).toBe("deny");
    expect(mock.edits[0]).toContain("거부");
  });

  test("a different user's click is refused and leaves the request pending", async () => {
    const { broker, prompts } = makeBroker();
    const { prompt } = await ask(broker, prompts);
    const mock = makeContext();

    await handlePermissionCallback(
      mock.ctx,
      prompt.approveData,
      CHAT_ID,
      USER_ID + 42,
      broker
    );

    expect(broker.pendingCount).toBe(1);
    expect(mock.edits).toHaveLength(0);
    expect(mock.answers[0]?.text).toBeDefined();
  });

  test("a click from another chat is refused and leaves the request pending", async () => {
    const { broker, prompts } = makeBroker();
    const { prompt } = await ask(broker, prompts);
    const mock = makeContext();

    await handlePermissionCallback(
      mock.ctx,
      prompt.approveData,
      -100200300,
      USER_ID,
      broker
    );

    expect(broker.pendingCount).toBe(1);
    expect(mock.edits).toHaveLength(0);
  });

  test("a click on a stale (superseded) message is refused", async () => {
    const { broker, prompts } = makeBroker();
    const { prompt } = await ask(broker, prompts);
    const mock = makeContext(MESSAGE_ID + 1);

    await handlePermissionCallback(
      mock.ctx,
      prompt.approveData,
      CHAT_ID,
      USER_ID,
      broker
    );

    expect(broker.pendingCount).toBe(1);
    expect(mock.edits).toHaveLength(0);
  });

  test("a callback query with no message object is refused", async () => {
    // grammY leaves `callbackQuery.message` undefined for updates it cannot
    // attach to a message; that must not bypass the message binding.
    const { broker, prompts } = makeBroker();
    const { prompt } = await ask(broker, prompts);
    const mock = makeContext(null);

    await handlePermissionCallback(
      mock.ctx,
      prompt.approveData,
      CHAT_ID,
      USER_ID,
      broker
    );

    expect(broker.pendingCount).toBe(1);
    expect(mock.edits).toHaveLength(0);
    expect(mock.answers[0]?.text).toBeDefined();
  });

  test("duplicate click after the answer is acknowledged without re-resolving", async () => {
    const { broker, prompts } = makeBroker();
    const { pending, prompt } = await ask(broker, prompts);

    const first = makeContext();
    await handlePermissionCallback(
      first.ctx,
      prompt.denyData,
      CHAT_ID,
      USER_ID,
      broker
    );
    const result = await pending;
    expect(result.behavior).toBe("deny");

    const second = makeContext();
    await handlePermissionCallback(
      second.ctx,
      prompt.approveData,
      CHAT_ID,
      USER_ID,
      broker
    );
    expect(second.answers).toHaveLength(1);
    expect(broker.pendingCount).toBe(0);
  });

  test("routes through handleCallback before generic unknown handling", async () => {
    // The real router: proves `perm:` data reaches the permission handler
    // (which answers with text) instead of falling through to the silent
    // unknown-callback acknowledgement.
    const { handleCallback } = await import("./callback");
    const answers: Array<{ text?: string } | undefined> = [];
    const ctx = {
      from: { id: USER_ID, username: "tester" },
      chat: { id: CHAT_ID, type: "private" },
      callbackQuery: {
        data: "perm:nosuchrequest:a",
        message: { message_id: MESSAGE_ID },
      },
      answerCallbackQuery: async (payload?: { text?: string }) => {
        answers.push(payload);
        return true;
      },
      editMessageReplyMarkup: async () => true,
    } as unknown as Context;

    await handleCallback(ctx);

    expect(answers).toHaveLength(1);
    expect(answers[0]?.text).toContain("만료");
  });

  test("an unauthorized user never reaches the permission handler", async () => {
    const { handleCallback } = await import("./callback");
    const answers: Array<{ text?: string } | undefined> = [];
    const ctx = {
      from: { id: 987654321, username: "intruder" },
      chat: { id: 987654321, type: "private" },
      callbackQuery: {
        data: "perm:nosuchrequest:a",
        message: { message_id: MESSAGE_ID },
      },
      answerCallbackQuery: async (payload?: { text?: string }) => {
        answers.push(payload);
        return true;
      },
    } as unknown as Context;

    await handleCallback(ctx);

    expect(answers[0]?.text).toBe("Unauthorized");
  });

  test("malformed callback data is acknowledged and resolves nothing", async () => {
    const { broker, prompts } = makeBroker();
    await ask(broker, prompts);
    const mock = makeContext();

    await handlePermissionCallback(mock.ctx, "perm:onlyid", CHAT_ID, USER_ID, broker);
    await handlePermissionCallback(mock.ctx, "perm:someid:x", CHAT_ID, USER_ID, broker);

    expect(broker.pendingCount).toBe(1);
    expect(mock.answers).toHaveLength(2);
  });
});
