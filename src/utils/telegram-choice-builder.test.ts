import { describe, test, expect } from "bun:test";
import { TelegramChoiceBuilder } from "./telegram-choice-builder";
import type { UserChoice, UserChoices } from "../types/user-choice";

const makeChoice = (overrides?: Partial<UserChoice>): UserChoice => ({
  type: "user_choice",
  question: "Test question",
  choices: [
    { id: "a", label: "Option A" },
    { id: "b", label: "Option B" },
  ],
  ...overrides,
});

const makeMultiChoices = (
  overrides?: Partial<UserChoices>
): UserChoices => ({
  type: "user_choices",
  questions: [
    {
      id: "q1",
      question: "First question",
      choices: [
        { id: "a", label: "Option A" },
        { id: "b", label: "Option B" },
      ],
    },
    {
      id: "q2",
      question: "Second question",
      choices: [
        { id: "c", label: "Option C" },
        { id: "d", label: "Option D" },
      ],
    },
  ],
  ...overrides,
});

describe("TelegramChoiceBuilder", () => {
  describe("buildSingleChoiceKeyboard", () => {
    test("creates keyboard with choices + direct input", () => {
      const choice = makeChoice();
      const keyboard = TelegramChoiceBuilder.buildSingleChoiceKeyboard(
        choice,
        "session-123"
      );

      expect(keyboard).toBeDefined();
      // Keyboard should have rows: 2 options + 1 direct input + 1 empty row = 4 rows
      // Grammy's InlineKeyboard.row() adds an empty row at the end
      const inlineKeyboard = (keyboard as any).inline_keyboard;
      expect(inlineKeyboard).toBeDefined();
      expect(inlineKeyboard.length).toBeGreaterThanOrEqual(3);

      // Check button structure
      expect(inlineKeyboard[0][0].text).toBe("Option A");
      expect(inlineKeyboard[0][0].callback_data).toMatch(/^c:[a-z0-9]{8}:a$/);
      expect(inlineKeyboard[1][0].text).toBe("Option B");
      expect(inlineKeyboard[2][0].text).toBe("✏️ Direct input");
    });

    test("throws when choices is empty", () => {
      const choice = makeChoice({ choices: [] });

      expect(() =>
        TelegramChoiceBuilder.buildSingleChoiceKeyboard(choice, "session-123")
      ).toThrow("at least one option");
    });

    test("handles maximum 8 choices", () => {
      const choice = makeChoice({
        choices: Array.from({ length: 8 }, (_, i) => ({
          id: String(i + 1),
          label: `Option ${i + 1}`,
        })),
      });

      const keyboard = TelegramChoiceBuilder.buildSingleChoiceKeyboard(
        choice,
        "session-123"
      );

      const inlineKeyboard = (keyboard as any).inline_keyboard;
      expect(inlineKeyboard.length).toBeGreaterThanOrEqual(9); // 8 options + 1 direct input (+ maybe empty row)
    });

    test("truncates long labels to 30 characters", () => {
      const longLabel = "This is a very long label that exceeds thirty characters";
      const choice = makeChoice({
        choices: [{ id: "1", label: longLabel }],
      });

      const keyboard = TelegramChoiceBuilder.buildSingleChoiceKeyboard(
        choice,
        "session-123"
      );

      const inlineKeyboard = (keyboard as any).inline_keyboard;
      expect(inlineKeyboard[0][0].text).toBe("This is a very long label t...");
      expect(inlineKeyboard[0][0].text.length).toBe(30);
    });
  });

  describe("buildMultiChoiceKeyboards", () => {
    test("returns array of keyboards for each question", () => {
      const choices = makeMultiChoices();
      const keyboards = TelegramChoiceBuilder.buildMultiChoiceKeyboards(
        choices,
        "session-123"
      );

      expect(keyboards.length).toBe(2);

      const kb1 = (keyboards[0] as any).inline_keyboard;
      expect(kb1[0][0].text).toBe("Option A");
      expect(kb1[0][0].callback_data).toMatch(/^c:[a-z0-9]{8}:q1:a$/);

      const kb2 = (keyboards[1] as any).inline_keyboard;
      expect(kb2[0][0].text).toBe("Option C");
      expect(kb2[0][0].callback_data).toMatch(/^c:[a-z0-9]{8}:q2:c$/);
    });

    test("throws when question has no choices", () => {
      const choices = makeMultiChoices({
        questions: [
          {
            id: "q1",
            question: "Empty question",
            choices: [],
          },
        ],
      });

      expect(() =>
        TelegramChoiceBuilder.buildMultiChoiceKeyboards(choices, "session-123")
      ).toThrow("at least one option");
    });
  });

  describe("compressSessionKey", () => {
    test("returns consistent hash for same input", () => {
      const key = "test-session-key";
      const hash1 = TelegramChoiceBuilder.compressSessionKey(key);
      const hash2 = TelegramChoiceBuilder.compressSessionKey(key);

      expect(hash1).toBe(hash2);
    });

    test("returns 8-character hash", () => {
      const key = "any-session-key-here";
      const hash = TelegramChoiceBuilder.compressSessionKey(key);

      expect(hash.length).toBe(8);
      expect(hash).toMatch(/^[a-z0-9]{8}$/);
    });

    test("returns different hashes for different inputs", () => {
      const hash1 = TelegramChoiceBuilder.compressSessionKey("session-1");
      const hash2 = TelegramChoiceBuilder.compressSessionKey("session-2");

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("helpers", () => {
    test("sanitizeId removes special characters", () => {
      const choice = makeChoice({
        choices: [{ id: "opt-1!", label: "Test" }],
      });

      const keyboard = TelegramChoiceBuilder.buildSingleChoiceKeyboard(
        choice,
        "session-123"
      );

      const inlineKeyboard = (keyboard as any).inline_keyboard;
      expect(inlineKeyboard[0][0].callback_data).toMatch(/:opt1$/);
    });

    test("sanitizeId limits to 4 characters", () => {
      const choice = makeChoice({
        choices: [{ id: "verylongid", label: "Test" }],
      });

      const keyboard = TelegramChoiceBuilder.buildSingleChoiceKeyboard(
        choice,
        "session-123"
      );

      const inlineKeyboard = (keyboard as any).inline_keyboard;
      expect(inlineKeyboard[0][0].callback_data).toMatch(/:very$/);
    });

    test("sanitizeId throws when no alphanumeric characters remain", () => {
      const choice = makeChoice({
        choices: [{ id: "!!!", label: "Test" }],
      });

      expect(() =>
        TelegramChoiceBuilder.buildSingleChoiceKeyboard(choice, "session-123")
      ).toThrow("Invalid");
    });

    test("callback data is under 64 bytes due to compression", () => {
      // compressSessionKey ensures callback data stays under limit
      // Format: c:{8-char-hash}:{4-char-id} = 3+8+4 = 15 chars max
      const longSessionKey =
        "very-long-session-key-that-could-exceed-limits-without-compression";
      const choice = makeChoice();

      const keyboard = TelegramChoiceBuilder.buildSingleChoiceKeyboard(
        choice,
        longSessionKey
      );

      const inlineKeyboard = (keyboard as any).inline_keyboard;
      const callbackData = inlineKeyboard[0][0].callback_data;
      expect(callbackData.length).toBeLessThan(64);
    });

    test("decompressSessionKey always throws", () => {
      expect(() =>
        TelegramChoiceBuilder.decompressSessionKey("a1b2c3d4")
      ).toThrow("not supported");
    });
  });
});
