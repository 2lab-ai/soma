/**
 * Regression: clicking a non-final question of a multi-question choice form
 * surfaced "Bot Error (unhandled) GrammyError: ... message is not modified".
 *
 * The pending branch edited the question text WITHOUT reply_markup (which in
 * the Telegram Bot API already drops the inline keyboard) and then called
 * editMessageReplyMarkup to remove the now-absent keyboard. Telegram rejects
 * that no-op with 400 "message is not modified"; the throw escaped to
 * bot.catch and answerCallbackQuery never ran (spinner hung).
 *
 * The fake ctx below models that Telegram behaviour. The final question is
 * never clicked here — that path hands the answer to Claude.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Context } from "grammy";
import { ALLOWED_USERS } from "../config";
import { sessionManager } from "../core/session/session-manager";
import type { ChoiceState } from "../types/user-choice";
import { TelegramChoiceBuilder } from "../utils/telegram-choice-builder";
import { handleCallback } from "./callback";

// Private chat: chat id === user id. Dedicated id so the allowlist injection
// and the session are independent of other test files.
const CHAT_ID = 770001;
const USER_ID = 770001;
const Q1_MESSAGE_ID = 5101;
const Q2_MESSAGE_ID = 5102;

type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

interface FakeTelegram {
  ctx: Context;
  answers: Array<{ text?: string } | undefined>;
  textEdits: string[];
  markup: { current: InlineKeyboard | undefined };
}

interface FakeOptions {
  editMessageTextThrows?: unknown;
}

function notModifiedError(method: string): Error {
  const error = new Error(
    `Call to '${method}' failed! (400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message)`
  );
  error.name = "GrammyError";
  return error;
}

function makeContext(callbackData: string, options: FakeOptions = {}): FakeTelegram {
  const answers: Array<{ text?: string } | undefined> = [];
  const textEdits: string[] = [];
  const markup: { current: InlineKeyboard | undefined } = {
    current: [[{ text: "PostgreSQL", callback_data: callbackData }]],
  };

  const ctx = {
    from: { id: USER_ID, username: "tester" },
    chat: { id: CHAT_ID, type: "private" },
    callbackQuery: {
      data: callbackData,
      message: { message_id: Q1_MESSAGE_ID },
    },
    answerCallbackQuery: async (payload?: { text?: string }) => {
      answers.push(payload);
      return true;
    },
    // Telegram semantics: editMessageText without reply_markup removes the
    // message's inline keyboard.
    editMessageText: async (
      text: string,
      other?: { reply_markup?: { inline_keyboard?: InlineKeyboard } }
    ) => {
      if (options.editMessageTextThrows) throw options.editMessageTextThrows;
      textEdits.push(text);
      markup.current = other?.reply_markup?.inline_keyboard;
      return true;
    },
    // Telegram semantics: requesting the markup the message already has is a
    // 400 "message is not modified".
    editMessageReplyMarkup: async (other?: {
      reply_markup?: { inline_keyboard?: InlineKeyboard };
    }) => {
      const next = other?.reply_markup?.inline_keyboard;
      const isEmpty = (kb: InlineKeyboard | undefined) => !kb || kb.length === 0;
      if (
        (isEmpty(next) && isEmpty(markup.current)) ||
        JSON.stringify(next) === JSON.stringify(markup.current)
      ) {
        throw notModifiedError("editMessageReplyMarkup");
      }
      markup.current = next;
      return true;
    },
    reply: async () => true,
  } as unknown as Context;

  return { ctx, answers, textEdits, markup };
}

function twoQuestionForm(): ChoiceState {
  return {
    type: "multi",
    formId: "form-choice-callback",
    messageIds: [Q1_MESSAGE_ID, Q2_MESSAGE_ID],
    extractedChoices: {
      type: "user_choices",
      questions: [
        {
          id: "q1",
          question: "Select database",
          choices: [
            { id: "pg", label: "PostgreSQL" },
            { id: "my", label: "MySQL" },
          ],
        },
        {
          id: "q2",
          question: "Select auth method",
          choices: [
            { id: "oauth", label: "OAuth" },
            { id: "jwt", label: "JWT" },
          ],
        },
      ],
    },
    selections: {},
  };
}

function transportError(method: string): Error {
  return new Error(`Network request for '${method}' failed!`);
}

function q1Callback(optionId: string): string {
  const key = TelegramChoiceBuilder.compressSessionKey(sessionManager.deriveKey(CHAT_ID));
  return `c:${key}:q1:${optionId}`;
}

let addedUserId = false;

beforeAll(() => {
  if (!ALLOWED_USERS.includes(USER_ID)) {
    ALLOWED_USERS.push(USER_ID);
    addedUserId = true;
  }
});

afterAll(() => {
  if (addedUserId) {
    const idx = ALLOWED_USERS.indexOf(USER_ID);
    if (idx !== -1) ALLOWED_USERS.splice(idx, 1);
  }
});

afterEach(() => {
  const session = sessionManager.getSession(CHAT_ID);
  session.clearChoiceState();
  session.clearDirectInput();
});

describe("multi-form choice callback: non-final question", () => {
  test("does not trip 'message is not modified' and always answers the callback", async () => {
    const session = sessionManager.getSession(CHAT_ID);
    session.choiceState = twoQuestionForm();

    const fake = makeContext(q1Callback("pg"));
    await expect(handleCallback(fake.ctx)).resolves.toBeUndefined();

    expect(fake.answers.length).toBe(1);
    expect(fake.answers[0]?.text?.startsWith("Selected:")).toBe(true);
    expect(fake.textEdits).toEqual(["Select database\n\n✓ PostgreSQL"]);
    // Keyboard removed by the text edit itself.
    expect(fake.markup.current).toBeUndefined();

    expect(session.choiceState).not.toBeNull();
    expect(session.choiceState?.selections?.q1).toEqual({
      choiceId: "pg",
      label: "PostgreSQL",
    });
    expect(session.choiceState?.selections?.q2).toBeUndefined();
  });

  test("a failing UI edit is best-effort: selection kept, callback still answered once", async () => {
    const session = sessionManager.getSession(CHAT_ID);
    session.choiceState = twoQuestionForm();

    const fake = makeContext(q1Callback("my"), {
      editMessageTextThrows: transportError("editMessageText"),
    });
    await expect(handleCallback(fake.ctx)).resolves.toBeUndefined();

    expect(fake.answers.length).toBe(1);
    expect(fake.answers[0]?.text?.startsWith("Selected:")).toBe(true);
    // The edit never landed, so the keyboard is still on the message.
    expect(fake.textEdits).toEqual([]);
    expect(fake.markup.current?.length).toBe(1);
    expect(session.choiceState?.selections?.q1).toEqual({
      choiceId: "my",
      label: "MySQL",
    });
  });
});

describe("multi-form choice callback: direct input", () => {
  test("a failing UI edit is best-effort: direct input armed, callback answered once", async () => {
    const session = sessionManager.getSession(CHAT_ID);
    session.choiceState = twoQuestionForm();

    const fake = makeContext(q1Callback("__direct"), {
      editMessageTextThrows: transportError("editMessageText"),
    });
    await expect(handleCallback(fake.ctx)).resolves.toBeUndefined();

    expect(fake.answers).toEqual([{ text: "Type your answer:" }]);
    expect(session.pendingDirectInput).toMatchObject({
      type: "multi",
      questionId: "q1",
      messageId: Q1_MESSAGE_ID,
    });
  });
});
