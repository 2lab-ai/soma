import { InlineKeyboard } from "grammy";
import { BUTTON_LABEL_MAX_LENGTH } from "../config";
import type { UserChoice, UserChoices, UserChoiceQuestion } from "../types/user-choice";
import type { SteeringMessage } from "../types";

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
      keyboard
        .text(`🔄 Change "${truncateLabel(selectedLabel)}"`, changeCallback)
        .row();
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

  /**
   * Build inline keyboard for lost message recovery.
   * @param sessionKey - Session identifier for callback routing
   * @returns InlineKeyboard with resend/discard/context/history options
   */
  static buildLostMessageKeyboard(sessionKey: string): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    const compressedKey = this.compressSessionKey(sessionKey);

    // Callback format: lost:{compressedKey}:{action}
    keyboard.text("📨 Resend", `lost:${compressedKey}:resend`).row();
    keyboard.text("🗑️ Discard", `lost:${compressedKey}:discard`).row();
    keyboard.text("📋 With Context", `lost:${compressedKey}:context`).row();
    keyboard.text("📜 With History", `lost:${compressedKey}:history`).row();

    return keyboard;
  }

  /**
   * Format lost messages for display in Telegram message.
   * Truncates and summarizes to fit Telegram limits.
   * @param messages - Lost steering messages
   * @param maxLength - Maximum total length (default 1000 chars)
   * @returns Formatted message preview
   */
  static formatLostMessagesPreview(
    messages: SteeringMessage[],
    maxLength = 1000
  ): string {
    if (messages.length === 0) return "";

    const lines: string[] = [];
    let currentLength = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      const time = new Date(msg.timestamp).toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

      // Truncate individual message content
      const content =
        msg.content.length > 100 ? msg.content.slice(0, 97) + "..." : msg.content;

      const line = `${i + 1}. [${time}] "${content}"`;

      if (currentLength + line.length + 1 > maxLength) {
        const remaining = messages.length - i;
        if (remaining > 0) {
          lines.push(`... and ${remaining} more message(s)`);
        }
        break;
      }

      lines.push(line);
      currentLength += line.length + 1;
    }

    return lines.join("\n");
  }

  /**
   * Build complete lost message notification message.
   * @param messages - Lost steering messages
   * @param isInterrupt - True if triggered by ! interrupt, false if /new
   * @returns Formatted message text
   */
  static buildLostMessageText(
    messages: SteeringMessage[],
    isInterrupt: boolean
  ): string {
    const header = isInterrupt
      ? `⚠️ **${messages.length}개 메시지가 전달되지 않았습니다**`
      : `🆕 **세션이 초기화되었습니다** (${messages.length}개 미전달 메시지)`;

    const preview = this.formatLostMessagesPreview(messages);

    const footer = `\n\n어떻게 처리할까요?
• **Resend**: 이 메시지들을 새로 전송
• **Discard**: 버리기
• **With Context**: 다음 대화에 참고용으로 첨부
• **With History**: 최근 10개 대화 기록과 함께 참고용 첨부`;

    return `${header}\n\n${preview}${footer}`;
  }
}
