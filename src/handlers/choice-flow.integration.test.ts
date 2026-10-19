import { describe, test, expect } from "bun:test";
import { ClaudeSession } from "../core/session/session";
import { UserChoiceExtractor } from "../utils/user-choice-extractor";
import { TelegramChoiceBuilder } from "../utils/telegram-choice-builder";

// Integration tests

describe("Choice Flow Integration", () => {
  describe("Single Choice Flow", () => {
    test("extracts choice JSON from Claude response and builds keyboard", async () => {
      const chatId = 123;
      const sessionKey = String(chatId);
      const session = new ClaudeSession(sessionKey);

      // Simulate Claude streaming response with choice JSON
      const claudeResponse = `Here's a question for you:

\`\`\`json
{
  "type": "user_choice",
  "question": "Which framework do you prefer?",
  "choices": [
    { "id": "react", "label": "React" },
    { "id": "vue", "label": "Vue" },
    { "id": "angular", "label": "Angular" }
  ]
}
\`\`\``;

      // Step 1: Extract choice from response
      const extracted = UserChoiceExtractor.extractUserChoice(claudeResponse);

      expect(extracted.choice).not.toBeNull();
      expect(extracted.choice?.question).toBe("Which framework do you prefer?");
      expect(extracted.choice?.choices.length).toBe(3);

      // Step 2: Build keyboard
      const keyboard = TelegramChoiceBuilder.buildSingleChoiceKeyboard(
        extracted.choice!,
        sessionKey
      );

      expect(keyboard).toBeDefined();
      const inlineKeyboard = (keyboard as any).inline_keyboard;
      expect(inlineKeyboard.length).toBeGreaterThanOrEqual(3);

      // Verify callback data format
      const firstButton = inlineKeyboard[0][0];
      expect(firstButton.text).toBe("React");
      expect(firstButton.callback_data).toMatch(/^c:[a-z0-9]{8}:reac$/);

      // Step 3: Store choice state in session
      session.choiceState = {
        type: "single",
        messageIds: [100],
        extractedChoice: extracted.choice!,
      };

      expect(session.choiceState?.type).toBe("single");
      expect(session.choiceState?.extractedChoice?.question).toBe(
        "Which framework do you prefer?"
      );
    });

    test("validates callback data matches session key", () => {
      const sessionKey = "123";
      const compressedKey = TelegramChoiceBuilder.compressSessionKey(sessionKey);

      // Valid callback
      const validCallback = `c:${compressedKey}:reac`;
      expect(validCallback).toMatch(/^c:[a-z0-9]{8}:[a-z0-9]{1,4}$/);

      // Invalid callback (wrong session)
      const wrongSessionKey = "456";
      const wrongCompressed = TelegramChoiceBuilder.compressSessionKey(wrongSessionKey);
      expect(compressedKey).not.toBe(wrongCompressed);
    });
  });

  describe("Multi-Form Flow", () => {
    test("builds separate keyboards for each question", () => {
      const sessionKey = "123";
      const multiChoices = {
        type: "user_choices" as const,
        title: "Configuration Setup",
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
      };

      const keyboards = TelegramChoiceBuilder.buildMultiChoiceKeyboards(
        multiChoices,
        sessionKey
      );

      expect(keyboards.length).toBe(2);

      // Q1 keyboard
      const kb1 = (keyboards[0] as any).inline_keyboard;
      expect(kb1[0][0].text).toBe("PostgreSQL");
      expect(kb1[0][0].callback_data).toMatch(/^c:[a-z0-9]{8}:q1:pg$/);

      // Q2 keyboard
      const kb2 = (keyboards[1] as any).inline_keyboard;
      expect(kb2[0][0].text).toBe("OAuth");
      expect(kb2[0][0].callback_data).toMatch(/^c:[a-z0-9]{8}:q2:oaut$/);
    });
  });

  describe("Error Cases", () => {
    test("handles empty choice array gracefully", () => {
      const text = `\`\`\`json
{
  "type": "user_choice",
  "question": "No options",
  "choices": []
}
\`\`\``;

      const extracted = UserChoiceExtractor.extractUserChoice(text);

      expect(extracted.choice).not.toBeNull();
      expect(extracted.choice?.choices.length).toBe(0);

      // Building keyboard with empty choices should throw
      expect(() =>
        TelegramChoiceBuilder.buildSingleChoiceKeyboard(extracted.choice!, "test-123")
      ).toThrow("at least one option");
    });

    test("handles malformed JSON without crashing", () => {
      const text = "Here is broken JSON: ```json\\n{invalid}\\n```";

      const extracted = UserChoiceExtractor.extractUserChoice(text);

      expect(extracted.choice).toBeNull();
      expect(extracted.choices).toBeNull();
      expect(extracted.textWithoutChoice).toBe(text);
    });

    test("handles missing choice state gracefully", () => {
      const session = new ClaudeSession("test-missing");

      expect(session.choiceState).toBeNull();

      // Clearing null state should not throw
      expect(() => session.clearChoiceState()).not.toThrow();
    });
  });

  describe("Direct Input Fallback", () => {
    test("direct input button always present", () => {
      const sessionKey = "123";
      const choice = {
        type: "user_choice" as const,
        question: "Test",
        choices: [{ id: "a", label: "A" }],
      };

      const keyboard = TelegramChoiceBuilder.buildSingleChoiceKeyboard(
        choice,
        sessionKey
      );

      const inlineKeyboard = (keyboard as any).inline_keyboard;
      const lastRow = inlineKeyboard[inlineKeyboard.length - 2]; // -2 because of empty row
      const directButton = lastRow?.[0];

      expect(directButton?.text).toBe("✏️ Direct input");
      expect(directButton?.callback_data).toMatch(/__direct$/);
    });

    test("direct input callback format for multi-form", () => {
      const sessionKey = "123";
      const multiChoices = {
        type: "user_choices" as const,
        questions: [
          {
            id: "q1",
            question: "Q1",
            choices: [{ id: "a", label: "A" }],
          },
        ],
      };

      const keyboards = TelegramChoiceBuilder.buildMultiChoiceKeyboards(
        multiChoices,
        sessionKey
      );

      const inlineKeyboard = (keyboards[0] as any).inline_keyboard;
      const lastRow = inlineKeyboard[inlineKeyboard.length - 2];
      const directButton = lastRow?.[0];

      expect(directButton?.text).toBe("✏️ Direct input");
      expect(directButton?.callback_data).toMatch(/^c:[a-z0-9]{8}:q1:__direct$/);
    });
  });
});
