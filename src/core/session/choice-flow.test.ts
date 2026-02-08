import { describe, expect, test } from "bun:test";
import {
  applyChoiceSelection,
  ChoiceTransitionError,
  createPendingDirectInput,
} from "./choice-flow";
import type { ChoiceState } from "../../types/user-choice";

const singleChoiceState: ChoiceState = {
  type: "single",
  messageIds: [101],
  extractedChoice: {
    type: "user_choice",
    question: "Choose one",
    choices: [
      { id: "a", label: "Option A" },
      { id: "b", label: "Option B" },
    ],
  },
};

const multiChoiceState: ChoiceState = {
  type: "multi",
  formId: "form-1",
  messageIds: [201, 202],
  extractedChoices: {
    type: "user_choices",
    questions: [
      {
        id: "q1",
        question: "Language?",
        choices: [
          { id: "ts", label: "TypeScript" },
          { id: "py", label: "Python" },
        ],
      },
      {
        id: "q2",
        question: "DB?",
        choices: [
          { id: "pg", label: "Postgres" },
          { id: "my", label: "MySQL" },
        ],
      },
    ],
  },
};

describe("choice-flow transitions", () => {
  test("completes single-choice selection", () => {
    const result = applyChoiceSelection(singleChoiceState, {
      mode: "single_option",
      optionId: "b",
    });

    expect(result.status).toBe("complete");
    expect(result.selectedLabel).toBe("Option B");
    expect(result.nextChoiceState).toBeNull();
  });

  test("keeps multi-form in pending state until all questions are answered", () => {
    const result = applyChoiceSelection(multiChoiceState, {
      mode: "multi_option",
      questionId: "q1",
      optionId: "ts",
    });

    expect(result.status).toBe("pending");
    if (result.status !== "pending") {
      throw new Error("Expected pending result");
    }
    expect(result.selectedLabel).toBe("TypeScript");
    expect(result.questionText).toBe("Language?");
    expect(result.nextChoiceState.selections?.q1?.label).toBe("TypeScript");
  });

  test("completes multi-form when final answer arrives", () => {
    const first = applyChoiceSelection(multiChoiceState, {
      mode: "multi_option",
      questionId: "q1",
      optionId: "py",
    });
    if (first.status !== "pending") {
      throw new Error("Expected pending result");
    }

    const complete = applyChoiceSelection(first.nextChoiceState, {
      mode: "multi_option",
      questionId: "q2",
      optionId: "pg",
    });

    expect(complete.status).toBe("complete");
    expect(complete.selectedLabel).toContain("Language?: Python");
    expect(complete.selectedLabel).toContain("DB?: Postgres");
  });

  test("supports direct input for multi-form questions", () => {
    const first = applyChoiceSelection(multiChoiceState, {
      mode: "multi_direct_input",
      questionId: "q1",
      label: "Rust",
    });
    if (first.status !== "pending") {
      throw new Error("Expected pending result");
    }

    const second = applyChoiceSelection(first.nextChoiceState, {
      mode: "multi_direct_input",
      questionId: "q2",
      label: "SQLite",
    });
    expect(second.status).toBe("complete");
    expect(second.selectedLabel).toContain("Language?: Rust");
    expect(second.selectedLabel).toContain("DB?: SQLite");
  });

  test("creates pending direct input from choice state", () => {
    const directInput = createPendingDirectInput(multiChoiceState, 999, 12345, "q1");
    expect(directInput.type).toBe("multi");
    expect(directInput.formId).toBe("form-1");
    expect(directInput.questionId).toBe("q1");
    expect(directInput.messageId).toBe(999);
    expect(directInput.createdAt).toBe(12345);
  });

  test("throws a typed transition error for invalid selections", () => {
    expect(() =>
      applyChoiceSelection(singleChoiceState, {
        mode: "single_option",
        optionId: "missing",
      })
    ).toThrow(ChoiceTransitionError);

    try {
      applyChoiceSelection(singleChoiceState, {
        mode: "single_option",
        optionId: "missing",
      });
      throw new Error("Expected ChoiceTransitionError");
    } catch (error) {
      if (!(error instanceof ChoiceTransitionError)) {
        throw error;
      }
      expect(error.code).toBe("CHOICE_INVALID_OPTION");
    }
  });
});
