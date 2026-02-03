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
