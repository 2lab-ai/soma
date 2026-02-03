import { describe, test, expect } from "bun:test";
import { StreamingState } from "./streaming";
import { UserChoiceExtractor } from "../utils/user-choice-extractor";

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
