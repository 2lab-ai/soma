import { describe, test, expect } from "bun:test";
import { UserChoiceExtractor } from "./user-choice-extractor";

describe("UserChoiceExtractor", () => {
  test("extracts user_choice from code block", () => {
    const text = `Here's a question:
\`\`\`json
{
  "type": "user_choice",
  "question": "Choose framework",
  "choices": [
    { "id": "1", "label": "React" },
    { "id": "2", "label": "Vue" }
  ]
}
\`\`\``;

    const result = UserChoiceExtractor.extractUserChoice(text);

    expect(result.choice).not.toBeNull();
    expect(result.choice?.question).toBe("Choose framework");
    expect(result.choice?.choices.length).toBe(2);
    expect(result.textWithoutChoice).toBe("Here's a question:");
  });

  test("extracts user_choice from raw JSON", () => {
    const text = `Consider this: { "type": "user_choice", "question": "Pick one", "choices": [{"id": "1", "label": "A"}] }`;

    const result = UserChoiceExtractor.extractUserChoice(text);

    expect(result.choice).not.toBeNull();
    expect(result.choice?.question).toBe("Pick one");
    expect(result.textWithoutChoice).toBe("Consider this:");
  });

  test("extracts user_choices (multi-question)", () => {
    const text = `\`\`\`json
{
  "type": "user_choices",
  "title": "Configuration",
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

    const result = UserChoiceExtractor.extractUserChoice(text);

    expect(result.choices).not.toBeNull();
    expect(result.choices?.questions.length).toBe(2);
    expect(result.choices?.title).toBe("Configuration");
  });

  test("normalizes user_choice_group to user_choices", () => {
    const text = `\`\`\`json
{
  "question": "Setup questions",
  "choices": [
    {
      "question": "Q1",
      "options": [{"id": "1", "label": "A"}]
    },
    {
      "question": "Q2",
      "options": [{"id": "1", "label": "B"}]
    }
  ]
}
\`\`\``;

    const result = UserChoiceExtractor.extractUserChoice(text);

    expect(result.choices).not.toBeNull();
    expect(result.choices?.questions.length).toBe(2);
    expect(result.choices?.title).toBe("Setup questions");
  });

  test("normalizes single-question user_choice_group to user_choice", () => {
    const text = `\`\`\`json
{
  "question": "Main question",
  "choices": [
    {
      "question": "Pick one",
      "options": [{"id": "1", "label": "Option A"}]
    }
  ]
}
\`\`\``;

    const result = UserChoiceExtractor.extractUserChoice(text);

    expect(result.choice).not.toBeNull();
    expect(result.choice?.question).toBe("Pick one");
  });

  test("returns empty for text without JSON", () => {
    const text = "Just a regular message with no choices";

    const result = UserChoiceExtractor.extractUserChoice(text);

    expect(result.choice).toBeNull();
    expect(result.choices).toBeNull();
    expect(result.textWithoutChoice).toBe(text);
  });

  test("handles malformed JSON gracefully", () => {
    const text = "Here's broken JSON: ```json\\n{invalid}\\n```";

    const result = UserChoiceExtractor.extractUserChoice(text);

    expect(result.choice).toBeNull();
    expect(result.choices).toBeNull();
  });

  test("supports both 'choices' and 'options' field names", () => {
    const text = `\`\`\`json
{
  "type": "user_choice",
  "question": "Test",
  "options": [{"id": "1", "label": "A"}]
}
\`\`\``;

    const result = UserChoiceExtractor.extractUserChoice(text);

    expect(result.choice).not.toBeNull();
    expect(result.choice?.choices.length).toBe(1);
  });

  test("handles escaped quotes inside JSON strings", () => {
    const text = `\`\`\`json
{
  "type": "user_choice",
  "question": "Use \\"quotes\\" in code?",
  "choices": [
    {"id": "1", "label": "Yes, use \\"quotes\\""},
    {"id": "2", "label": "No"}
  ]
}
\`\`\``;

    const result = UserChoiceExtractor.extractUserChoice(text);

    expect(result.choice).not.toBeNull();
    expect(result.choice?.question).toBe('Use "quotes" in code?');
    expect(result.choice?.choices[0]?.label).toBe('Yes, use "quotes"');
  });

  test("handles empty choices array", () => {
    const text = `\`\`\`json
{
  "type": "user_choice",
  "question": "No options",
  "choices": []
}
\`\`\``;

    const result = UserChoiceExtractor.extractUserChoice(text);

    expect(result.choice).not.toBeNull();
    expect(result.choice?.choices.length).toBe(0);
  });

  test("extracts second JSON when first is invalid", () => {
    const text = `First try: \`\`\`json
{broken}
\`\`\`

Second try: \`\`\`json
{
  "type": "user_choice",
  "question": "Valid",
  "choices": [{"id": "1", "label": "A"}]
}
\`\`\``;

    const result = UserChoiceExtractor.extractUserChoice(text);

    expect(result.choice).not.toBeNull();
    expect(result.choice?.question).toBe("Valid");
  });

  test("handles truncated/incomplete JSON", () => {
    const text = `\`\`\`json
{
  "type": "user_ch`;

    const result = UserChoiceExtractor.extractUserChoice(text);

    expect(result.choice).toBeNull();
    expect(result.choices).toBeNull();
  });

  test("handles Unicode characters (Korean)", () => {
    const text = `\`\`\`json
{
  "type": "user_choice",
  "question": "어떤 프레임워크를 선호하시나요?",
  "choices": [
    {"id": "1", "label": "리액트"},
    {"id": "2", "label": "뷰"}
  ]
}
\`\`\``;

    const result = UserChoiceExtractor.extractUserChoice(text);

    expect(result.choice).not.toBeNull();
    expect(result.choice?.question).toBe("어떤 프레임워크를 선호하시나요?");
    expect(result.choice?.choices[0]?.label).toBe("리액트");
  });

  test("handles leading/trailing whitespace in code blocks", () => {
    const text = `\`\`\`json

  {
    "type": "user_choice",
    "question": "Whitespace test",
    "choices": [{"id": "1", "label": "A"}]
  }

\`\`\``;

    const result = UserChoiceExtractor.extractUserChoice(text);

    expect(result.choice).not.toBeNull();
    expect(result.choice?.question).toBe("Whitespace test");
  });

  test("ignores invalid type field", () => {
    const text = `\`\`\`json
{
  "type": "unknown_type",
  "question": "Should be ignored",
  "choices": [{"id": "1", "label": "A"}]
}
\`\`\``;

    const result = UserChoiceExtractor.extractUserChoice(text);

    expect(result.choice).toBeNull();
    expect(result.choices).toBeNull();
  });

  test("handles nested objects in choices", () => {
    const text = `\`\`\`json
{
  "type": "user_choice",
  "question": "Complex",
  "choices": [
    {
      "id": "1",
      "label": "Option with nested data",
      "description": "Has { 'nested': 'value' } inside"
    }
  ]
}
\`\`\``;

    const result = UserChoiceExtractor.extractUserChoice(text);

    expect(result.choice).not.toBeNull();
    expect(result.choice?.choices[0]?.description).toContain("nested");
  });
});
