import { describe, test, expect, mock } from "bun:test";
import { StreamingState, createStatusCallback } from "./streaming";
import { UserChoiceExtractor } from "../utils/user-choice-extractor";
import type { QueryMetadata } from "../types";

describe("StreamingState - JSON extraction", () => {
  test("initializes with no extracted choice", () => {
    const state = new StreamingState();

    expect(state.extractedChoice).toBeNull();
    expect(state.extractedChoices).toBeNull();
    expect(state.hasUserChoice).toBe(false);
  });

  test("can store extracted single choice", () => {
    const state = new StreamingState();
    const content = `Here's a question:
\`\`\`json
{
  "type": "user_choice",
  "question": "Choose one",
  "choices": [
    { "id": "1", "label": "Option A" },
    { "id": "2", "label": "Option B" }
  ]
}
\`\`\``;

    const extracted = UserChoiceExtractor.extractUserChoice(content);

    state.extractedChoice = extracted.choice;
    state.extractedChoices = extracted.choices;
    state.hasUserChoice = !!(extracted.choice || extracted.choices);

    expect(state.hasUserChoice).toBe(true);
    expect(state.extractedChoice).not.toBeNull();
    expect(state.extractedChoice?.question).toBe("Choose one");
    expect(state.extractedChoices).toBeNull();
  });

  test("can store extracted multi-form choices", () => {
    const state = new StreamingState();
    const content = `\`\`\`json
{
  "type": "user_choices",
  "title": "Setup",
  "questions": [
    {
      "id": "q1",
      "question": "Database?",
      "choices": [{"id": "1", "label": "Postgres"}]
    },
    {
      "id": "q2",
      "question": "Auth?",
      "choices": [{"id": "1", "label": "OAuth"}]
    }
  ]
}
\`\`\``;

    const extracted = UserChoiceExtractor.extractUserChoice(content);

    state.extractedChoice = extracted.choice;
    state.extractedChoices = extracted.choices;
    state.hasUserChoice = !!(extracted.choice || extracted.choices);

    expect(state.hasUserChoice).toBe(true);
    expect(state.extractedChoices).not.toBeNull();
    expect(state.extractedChoices?.questions.length).toBe(2);
    expect(state.extractedChoice).toBeNull();
  });

  test("textWithoutChoice strips JSON from content", () => {
    const content = `Let me ask you something:
\`\`\`json
{
  "type": "user_choice",
  "question": "Pick",
  "choices": [{"id": "1", "label": "A"}]
}
\`\`\``;

    const extracted = UserChoiceExtractor.extractUserChoice(content);

    expect(extracted.textWithoutChoice).toBe("Let me ask you something:");
    expect(extracted.textWithoutChoice).not.toContain("```json");
    expect(extracted.textWithoutChoice).not.toContain("user_choice");
  });

  test("hasUserChoice is false when no JSON found", () => {
    const state = new StreamingState();
    const content = "Just a regular response with no choices.";

    const extracted = UserChoiceExtractor.extractUserChoice(content);

    state.extractedChoice = extracted.choice;
    state.extractedChoices = extracted.choices;
    state.hasUserChoice = !!(extracted.choice || extracted.choices);

    expect(state.hasUserChoice).toBe(false);
    expect(state.extractedChoice).toBeNull();
    expect(state.extractedChoices).toBeNull();
  });

  test("cleanup does not affect extracted choices", () => {
    const state = new StreamingState();

    state.extractedChoice = {
      type: "user_choice",
      question: "Test",
      choices: [{ id: "1", label: "A" }],
    };
    state.hasUserChoice = true;

    state.cleanup();

    // cleanup only clears progressTimer
    expect(state.extractedChoice).not.toBeNull();
    expect(state.hasUserChoice).toBe(true);
    expect(state.progressTimer).toBeNull();
  });
});

describe("Model name header in done handler", () => {
  function createMockCtx() {
    const editCalls: Array<{ chatId: number; msgId: number; text: string }> = [];
    const replyCalls: Array<{ text: string }> = [];
    const reactionCalls: Array<{ emoji: string }> = [];

    return {
      editCalls,
      replyCalls,
      reactionCalls,
      ctx: {
        chat: { id: 123 },
        message: { message_id: 1 },
        api: {
          editMessageText: mock(async (chatId: number, msgId: number, text: string) => {
            editCalls.push({ chatId, msgId, text });
            return true;
          }),
          setMessageReaction: mock(async () => true),
          deleteMessage: mock(async () => true),
        },
        reply: mock(async (text: string) => {
          replyCalls.push({ text });
          return { chat: { id: 123 }, message_id: replyCalls.length + 100 };
        }),
        react: mock(async (emoji: string) => {
          reactionCalls.push({ emoji });
        }),
      },
    };
  }

  test("prepends model name to first segment on done", async () => {
    const { ctx, editCalls } = createMockCtx();
    const state = new StreamingState();

    const callback = await createStatusCallback(ctx as any, state);

    await callback("text", "Hello world", 0);
    expect(state.textMessages.size).toBeGreaterThan(0);

    const metadata: QueryMetadata = {
      usageBefore: null,
      usageAfter: null,
      toolDurations: {},
      queryDurationMs: 1000,
      modelDisplayName: "Opus 4.6",
    };

    await callback("segment_end", "Hello world", 0);
    await callback("done", "", undefined, metadata);

    const headerEdit = editCalls.find((c) => c.text.includes("Opus 4.6"));
    expect(headerEdit).toBeTruthy();
    expect(headerEdit!.text.startsWith("<code>Opus 4.6</code>\n")).toBe(true);
  });

  test("skips header when modelDisplayName is undefined", async () => {
    const { ctx, editCalls } = createMockCtx();
    const state = new StreamingState();

    const callback = await createStatusCallback(ctx as any, state);

    await callback("text", "Response", 0);
    await callback("segment_end", "Response", 0);

    const metadata: QueryMetadata = {
      usageBefore: null,
      usageAfter: null,
      toolDurations: {},
      queryDurationMs: 1000,
    };

    await callback("done", "", undefined, metadata);

    const headerEdit = editCalls.find((c) => c.text.includes("<code>"));
    expect(headerEdit).toBeUndefined();
  });

  test("skips header when combined length exceeds Telegram limit", async () => {
    const { ctx, editCalls } = createMockCtx();
    const state = new StreamingState();

    const callback = await createStatusCallback(ctx as any, state);

    const longContent = "x".repeat(4090);
    await callback("text", longContent, 0);
    await callback("segment_end", longContent, 0);

    const metadata: QueryMetadata = {
      usageBefore: null,
      usageAfter: null,
      toolDurations: {},
      queryDurationMs: 1000,
      modelDisplayName: "Opus 4.6",
    };

    await callback("done", "", undefined, metadata);

    const headerEdit = editCalls.find((c) => c.text.includes("<code>Opus 4.6</code>"));
    expect(headerEdit).toBeUndefined();
  });
});
