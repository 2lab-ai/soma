import { InlineKeyboard } from "grammy";
import { BUTTON_LABEL_MAX_LENGTH } from "../config";
import type { UserChoice, UserChoices, UserChoiceQuestion } from "../types/user-choice";

function truncateLabel(label: string): string {
  if (label.length <= BUTTON_LABEL_MAX_LENGTH) return label;
  return label.slice(0, BUTTON_LABEL_MAX_LENGTH - 3) + "...";
}

function sanitizeId(id: string, fieldName: string): string {
  const safe = id.replace(/[^a-z0-9]/gi, "").slice(0, 4);
  if (!safe) {
    throw new Error(
      `Invalid ${fieldName} "${id}": must contain alphanumeric characters`
    );
  }
  return safe;
}

function validateCallbackData(data: string): void {
  if (data.length > 64) {
    throw new Error(
      `Callback data too long (${data.length} bytes): ${data}. Use shorter session keys or IDs.`
    );
  }
}

export class TelegramChoiceBuilder {
  static buildSingleChoiceKeyboard(
    choice: UserChoice,
    sessionKey: string
  ): InlineKeyboard {
    if (!choice.choices?.length) {
      throw new Error("UserChoice must have at least one option");
    }

    const keyboard = new InlineKeyboard();
    const compressedKey = this.compressSessionKey(sessionKey);

    for (const option of choice.choices) {
      const safeOptionId = sanitizeId(option.id, "option ID");
      const callbackData = `c:${compressedKey}:${safeOptionId}`;
      validateCallbackData(callbackData);
      keyboard.text(truncateLabel(option.label), callbackData).row();
    }

    keyboard.text("✏️ Direct input", `c:${compressedKey}:__direct`).row();
    return keyboard;
  }

  static buildMultiChoiceKeyboards(
    choices: UserChoices,
    sessionKey: string
  ): InlineKeyboard[] {
    return choices.questions.map((q) => this.buildQuestionKeyboard(q, sessionKey));
  }

  /**
   * Build a unified multi-form keyboard with progress tracking.
   * Shows answered questions as summaries, current unanswered question with options.
   * @param choices - Multi-question form definition
   * @param sessionKey - Session identifier for callback compression
   * @param formId - Unique form identifier for callback routing
   * @param selections - Current user selections (questionId -> {choiceId, label})
   * @returns Single InlineKeyboard with progressive UI
   */
  static buildMultiFormKeyboard(
    choices: UserChoices,
    sessionKey: string,
    formId: string,
    selections: Record<string, { choiceId: string; label: string }> = {}
  ): InlineKeyboard {
    if (!choices.questions?.length) {
      throw new Error("UserChoices must have at least one question");
    }

    const keyboard = new InlineKeyboard();
    const compressedKey = this.compressSessionKey(sessionKey);
    const totalQuestions = choices.questions.length;
    const answeredCount = Object.keys(selections).length;

    // Progress indicator: ●●○○○
    const progressIndicator =
      "●".repeat(answeredCount) +
      "○".repeat(totalQuestions - answeredCount);

    // Find first unanswered question
    const firstUnanswered = choices.questions.find((q) => !selections[q.id]);

    // If all answered, show submit/reset
    if (!firstUnanswered) {
      // Submit button
      const submitCallback = `mc:${compressedKey}:${formId}:__submit`;
      validateCallbackData(submitCallback);
      keyboard.text("🚀 Submit", submitCallback).row();

      // Reset button
      const resetCallback = `mc:${compressedKey}:${formId}:__reset`;
      validateCallbackData(resetCallback);
      keyboard.text("🗑️ Reset", resetCallback).row();

      return keyboard;
    }

    // Show current question options
    const safeQuestionId = sanitizeId(firstUnanswered.id, "question ID");

    for (const option of firstUnanswered.choices) {
      const safeOptionId = sanitizeId(option.id, "option ID");
      const callbackData = `mc:${compressedKey}:${formId}:${safeQuestionId}:${safeOptionId}`;
      validateCallbackData(callbackData);
      keyboard.text(truncateLabel(option.label), callbackData).row();
    }

    // Direct input button for current question
    const directCallback = `mc:${compressedKey}:${formId}:${safeQuestionId}:__direct`;
    validateCallbackData(directCallback);
    keyboard.text("✏️ Direct input", directCallback).row();

    // Change buttons for answered questions (max 3 to avoid keyboard bloat)
    const answeredQuestions = choices.questions.filter((q) => selections[q.id]);
    for (const q of answeredQuestions.slice(0, 3)) {
      const safeQId = sanitizeId(q.id, "question ID");
      const changeCallback = `mc:${compressedKey}:${formId}:${safeQId}:__change`;
      validateCallbackData(changeCallback);
      const selectedLabel = selections[q.id]!.label;
      keyboard.text(
        `🔄 Change "${truncateLabel(selectedLabel)}"`,
        changeCallback
      ).row();
    }

    return keyboard;
  }

  private static buildQuestionKeyboard(
    question: UserChoiceQuestion,
    sessionKey: string
  ): InlineKeyboard {
    if (!question.choices?.length) {
      throw new Error(`Question "${question.id}" must have at least one option`);
    }

    const keyboard = new InlineKeyboard();
    const compressedKey = this.compressSessionKey(sessionKey);
    const safeQuestionId = sanitizeId(question.id, "question ID");

    for (const option of question.choices) {
      const safeOptionId = sanitizeId(option.id, "option ID");
      const callbackData = `c:${compressedKey}:${safeQuestionId}:${safeOptionId}`;
      validateCallbackData(callbackData);
      keyboard.text(truncateLabel(option.label), callbackData).row();
    }

    keyboard
      .text("✏️ Direct input", `c:${compressedKey}:${safeQuestionId}:__direct`)
      .row();
    return keyboard;
  }

  static compressSessionKey(sessionKey: string): string {
    return Bun.hash(sessionKey).toString(36).slice(0, 8);
  }

  static decompressSessionKey(_compressedKey: string): never {
    throw new Error(
      "Session key decompression not supported (one-way hash). Use chatId from callback query context instead."
    );
  }
}
