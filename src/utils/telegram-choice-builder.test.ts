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

const makeMultiChoices = (overrides?: Partial<UserChoices>): UserChoices => ({
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

  describe("buildMultiFormKeyboard", () => {
    test("shows first question options when no selections", () => {
      const choices = makeMultiChoices();
      const keyboard = TelegramChoiceBuilder.buildMultiFormKeyboard(
        choices,
        "session-123",
        "form-abc",
        {}
      );

      const inlineKeyboard = (keyboard as any).inline_keyboard;

      // Should show options for first question (q1)
      expect(inlineKeyboard[0][0].text).toBe("Option A");
      expect(inlineKeyboard[0][0].callback_data).toMatch(
        /^mc:[a-z0-9]{8}:form-abc:q1:a$/
      );
      expect(inlineKeyboard[1][0].text).toBe("Option B");
      expect(inlineKeyboard[1][0].callback_data).toMatch(
        /^mc:[a-z0-9]{8}:form-abc:q1:b$/
      );

      // Should have direct input button
      expect(inlineKeyboard[2][0].text).toBe("✏️ Direct input");
      expect(inlineKeyboard[2][0].callback_data).toMatch(
        /^mc:[a-z0-9]{8}:form-abc:q1:__direct$/
      );
    });

    test("shows second question after first answered", () => {
      const choices = makeMultiChoices();
      const selections = {
        q1: { choiceId: "a", label: "Option A" },
      };

      const keyboard = TelegramChoiceBuilder.buildMultiFormKeyboard(
        choices,
        "session-123",
        "form-abc",
        selections
      );

      const inlineKeyboard = (keyboard as any).inline_keyboard;

      // Should show options for second question (q2)
      expect(inlineKeyboard[0][0].text).toBe("Option C");
      expect(inlineKeyboard[0][0].callback_data).toMatch(
        /^mc:[a-z0-9]{8}:form-abc:q2:c$/
      );
      expect(inlineKeyboard[1][0].text).toBe("Option D");

      // Should have change button for q1
      const changeButton = inlineKeyboard.find((row: any) =>
        row[0]?.text?.includes("🔄 Change")
      );
      expect(changeButton).toBeDefined();
      expect(changeButton[0].text).toContain("Option A");
    });

    test("shows submit/reset when all answered", () => {
      const choices = makeMultiChoices();
      const selections = {
        q1: { choiceId: "a", label: "Option A" },
        q2: { choiceId: "c", label: "Option C" },
      };

      const keyboard = TelegramChoiceBuilder.buildMultiFormKeyboard(
        choices,
        "session-123",
        "form-abc",
        selections
      );

      const inlineKeyboard = (keyboard as any).inline_keyboard;

      // Should show submit button
      expect(inlineKeyboard[0][0].text).toBe("🚀 Submit");
      expect(inlineKeyboard[0][0].callback_data).toMatch(
        /^mc:[a-z0-9]{8}:form-abc:__submit$/
      );

      // Should show reset button
      expect(inlineKeyboard[1][0].text).toBe("🗑️ Reset");
      expect(inlineKeyboard[1][0].callback_data).toMatch(
        /^mc:[a-z0-9]{8}:form-abc:__reset$/
      );
    });

    test("throws when choices is empty", () => {
      const choices = makeMultiChoices({ questions: [] });

      expect(() =>
        TelegramChoiceBuilder.buildMultiFormKeyboard(
          choices,
          "session-123",
          "form-abc",
          {}
        )
      ).toThrow("at least one question");
    });

    test("handles 3 questions with partial completion", () => {
      const choices: UserChoices = {
        type: "user_choices",
        questions: [
          {
            id: "q1",
            question: "Question 1",
            choices: [{ id: "a", label: "A" }],
          },
          {
            id: "q2",
            question: "Question 2",
            choices: [{ id: "b", label: "B" }],
          },
          {
            id: "q3",
            question: "Question 3",
            choices: [{ id: "c", label: "C" }],
          },
        ],
      };

      const selections = {
        q1: { choiceId: "a", label: "A" },
      };

      const keyboard = TelegramChoiceBuilder.buildMultiFormKeyboard(
        choices,
        "session-123",
        "form-abc",
        selections
      );

      const inlineKeyboard = (keyboard as any).inline_keyboard;

      // Should show q2 options (first unanswered)
      expect(inlineKeyboard[0][0].text).toBe("B");

      // Should have change button for q1
      const changeButton = inlineKeyboard.find((row: any) =>
        row[0]?.text?.includes("🔄 Change")
      );
      expect(changeButton).toBeDefined();
    });

    test("callback data stays under 64 bytes", () => {
      const longFormId = "form-with-very-long-identifier";
      const choices = makeMultiChoices();

      const keyboard = TelegramChoiceBuilder.buildMultiFormKeyboard(
        choices,
        "session-123",
        longFormId,
        {}
      );

      const inlineKeyboard = (keyboard as any).inline_keyboard;

      // Check all callback data lengths
      for (const row of inlineKeyboard) {
        for (const button of row) {
          expect(button.callback_data.length).toBeLessThan(64);
        }
      }
    });

    test("truncates long labels in change buttons", () => {
      const longLabel =
        "This is a very long option label that exceeds thirty characters";
      const choices: UserChoices = {
        type: "user_choices",
        questions: [
          {
            id: "q1",
            question: "Question 1",
            choices: [{ id: "a", label: longLabel }],
          },
          {
            id: "q2",
            question: "Question 2",
            choices: [{ id: "b", label: "B" }],
          },
        ],
      };

      const selections = {
        q1: { choiceId: "a", label: longLabel },
      };

      const keyboard = TelegramChoiceBuilder.buildMultiFormKeyboard(
        choices,
        "session-123",
        "form-abc",
        selections
      );

      const inlineKeyboard = (keyboard as any).inline_keyboard;

      // Find change button
      const changeButton = inlineKeyboard.find((row: any) =>
        row[0]?.text?.includes("🔄 Change")
      );

      // Change button text should be truncated
      expect(changeButton[0].text).toContain("...");
      expect(changeButton[0].text.length).toBeLessThanOrEqual(45); // "🔄 Change \"" + 30 + "\""
    });

    test("limits change buttons to 3 max", () => {
      const choices: UserChoices = {
        type: "user_choices",
        questions: [
          { id: "q1", question: "Q1", choices: [{ id: "a", label: "A" }] },
          { id: "q2", question: "Q2", choices: [{ id: "b", label: "B" }] },
          { id: "q3", question: "Q3", choices: [{ id: "c", label: "C" }] },
          { id: "q4", question: "Q4", choices: [{ id: "d", label: "D" }] },
          { id: "q5", question: "Q5", choices: [{ id: "e", label: "E" }] },
        ],
      };

      // Answer first 4 questions
      const selections = {
        q1: { choiceId: "a", label: "A" },
        q2: { choiceId: "b", label: "B" },
        q3: { choiceId: "c", label: "C" },
        q4: { choiceId: "d", label: "D" },
      };

      const keyboard = TelegramChoiceBuilder.buildMultiFormKeyboard(
        choices,
        "session-123",
        "form-abc",
        selections
      );

      const inlineKeyboard = (keyboard as any).inline_keyboard;

      // Count change buttons
      const changeButtons = inlineKeyboard.filter((row: any) =>
        row[0]?.text?.includes("🔄 Change")
      );

      expect(changeButtons.length).toBeLessThanOrEqual(3);
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
      expect(() => TelegramChoiceBuilder.decompressSessionKey("a1b2c3d4")).toThrow(
        "not supported"
      );
    });
  });
});
