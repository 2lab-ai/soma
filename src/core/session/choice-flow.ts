import type { ChoiceState, DirectInputState } from "../../types/user-choice";

export type ChoiceTransitionErrorCode =
  | "CHOICE_MISSING_STATE"
  | "CHOICE_MISSING_DATA"
  | "CHOICE_INVALID_MODE"
  | "CHOICE_INVALID_QUESTION"
  | "CHOICE_INVALID_OPTION";

export class ChoiceTransitionError extends Error {
  readonly code: ChoiceTransitionErrorCode;

  constructor(code: ChoiceTransitionErrorCode, message: string) {
    super(message);
    this.name = "ChoiceTransitionError";
    this.code = code;
  }
}

export type ChoiceSelectionInput =
  | { mode: "single_option"; optionId: string }
  | { mode: "multi_option"; questionId: string; optionId: string }
  | { mode: "multi_direct_input"; questionId: string; label: string };

export type ChoiceSelectionResult =
  | {
      status: "pending";
      selectedLabel: string;
      questionText: string;
      nextChoiceState: ChoiceState;
    }
  | {
      status: "complete";
      selectedLabel: string;
      nextChoiceState: null;
    };

function assertChoiceState(choiceState: ChoiceState | null): ChoiceState {
  if (!choiceState) {
    throw new ChoiceTransitionError(
      "CHOICE_MISSING_STATE",
      "Choice state does not exist."
    );
  }
  return choiceState;
}

function buildAnswerSummary(choiceState: ChoiceState): string {
  const choices = choiceState.extractedChoices;
  const selections = choiceState.selections || {};
  if (!choices) {
    throw new ChoiceTransitionError("CHOICE_MISSING_DATA", "Form data not found.");
  }

  return choices.questions
    .map((question) => {
      const selection = selections[question.id];
      if (!selection) return null;
      return `${question.question}: ${selection.label}`;
    })
    .filter(Boolean)
    .join("\n");
}

export function createPendingDirectInput(
  choiceState: ChoiceState | null,
  messageId: number,
  createdAt: number,
  questionId?: string
): DirectInputState {
  const state = assertChoiceState(choiceState);
  return {
    type: state.type,
    formId: state.formId,
    questionId,
    messageId,
    createdAt,
  };
}

export function applyChoiceSelection(
  choiceState: ChoiceState | null,
  selection: ChoiceSelectionInput
): ChoiceSelectionResult {
  const state = assertChoiceState(choiceState);

  if (state.type === "single") {
    if (selection.mode !== "single_option") {
      throw new ChoiceTransitionError(
        "CHOICE_INVALID_MODE",
        "Single choice state only accepts single option selections."
      );
    }
    const choice = state.extractedChoice;
    if (!choice) {
      throw new ChoiceTransitionError("CHOICE_MISSING_DATA", "Choice data not found.");
    }
    const selected = choice.choices.find((option) => option.id === selection.optionId);
    if (!selected) {
      throw new ChoiceTransitionError("CHOICE_INVALID_OPTION", "Invalid option.");
    }
    return {
      status: "complete",
      selectedLabel: selected.label,
      nextChoiceState: null,
    };
  }

  if (selection.mode === "single_option") {
    throw new ChoiceTransitionError(
      "CHOICE_INVALID_MODE",
      "Multi-form state requires question-scoped selection."
    );
  }

  const choices = state.extractedChoices;
  if (!choices) {
    throw new ChoiceTransitionError("CHOICE_MISSING_DATA", "Form data not found.");
  }

  const question = choices.questions.find((q) => q.id === selection.questionId);
  if (!question) {
    throw new ChoiceTransitionError("CHOICE_INVALID_QUESTION", "Question not found.");
  }

  let selectedLabel: string;
  let choiceId: string;

  if (selection.mode === "multi_option") {
    const option = question.choices.find((candidate) => candidate.id === selection.optionId);
    if (!option) {
      throw new ChoiceTransitionError("CHOICE_INVALID_OPTION", "Invalid option.");
    }
    selectedLabel = option.label;
    choiceId = selection.optionId;
  } else {
    selectedLabel = selection.label;
    choiceId = "__direct__";
  }

  const nextSelections = {
    ...(state.selections || {}),
    [question.id]: {
      choiceId,
      label: selectedLabel,
    },
  };

  const nextState: ChoiceState = {
    ...state,
    selections: nextSelections,
  };

  const allAnswered = Object.keys(nextSelections).length === choices.questions.length;
  if (!allAnswered) {
    return {
      status: "pending",
      selectedLabel,
      questionText: question.question,
      nextChoiceState: nextState,
    };
  }

  const answers = buildAnswerSummary(nextState);
  return {
    status: "complete",
    selectedLabel: `Answered all questions:\n${answers}`,
    nextChoiceState: null,
  };
}
