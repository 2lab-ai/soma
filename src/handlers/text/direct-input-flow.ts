import type { Context } from "grammy";
import { rateLimiter } from "../../security";
import { sendSystemMessage } from "../../utils/system-message";
import {
  handleAbortError,
  formatErrorForLog,
  formatErrorForUser,
} from "../../utils/error-classification";
import {
  StreamingState,
  cleanupToolMessages,
  createStatusCallback,
} from "../streaming";
import { auditLog, auditLogRateLimit } from "../../utils/audit";
import { startTypingIndicator } from "../../utils/typing";
import {
  applyChoiceSelection,
  ChoiceTransitionError,
} from "../../core/session/choice-flow";
import type { ClaudeSession } from "../../core/session/session";

const DIRECT_INPUT_EXPIRY_MS = 5 * 60 * 1000;

async function editMessageSilently(
  ctx: Context,
  chatId: number,
  messageId: number,
  text: string
): Promise<void> {
  try {
    await ctx.api.editMessageText(chatId, messageId, text);
  } catch (error) {
    console.error("Failed to update direct input message:", error);
    await ctx.reply("✓ Answer recorded (display update failed)").catch(() => {});
  }
}

function isExpired(createdAt: number): boolean {
  return Date.now() - createdAt > DIRECT_INPUT_EXPIRY_MS;
}

interface MultiFormResult {
  complete: boolean;
  selectedLabel: string;
}

async function handleMultiFormInput(
  ctx: Context,
  session: ClaudeSession,
  chatId: number,
  directInput: NonNullable<ClaudeSession["pendingDirectInput"]>,
  message: string
): Promise<MultiFormResult> {
  if (!directInput.questionId) {
    await sendSystemMessage(ctx, "⚠️ Form expired. Please ask again.");
    return { complete: false, selectedLabel: "" };
  }

  try {
    const transition = applyChoiceSelection(session.choiceState, {
      mode: "multi_direct_input",
      questionId: directInput.questionId,
      label: message,
    });

    if (transition.status === "pending") {
      session.choiceState = transition.nextChoiceState;
      await editMessageSilently(
        ctx,
        chatId,
        directInput.messageId,
        `✓ ${message.slice(0, 100)}`
      );
      await ctx.reply("👌 Answer recorded. Continue with other questions.");
      return { complete: false, selectedLabel: "" };
    }

    session.clearChoiceState();
    session.setActivityState("working");
    return { complete: true, selectedLabel: transition.selectedLabel };
  } catch (error) {
    if (error instanceof ChoiceTransitionError) {
      await sendSystemMessage(ctx, "⚠️ Form data expired. Please ask again.");
      return { complete: false, selectedLabel: "" };
    }
    throw error;
  }
}

async function sendDirectInputToClaude(
  ctx: Context,
  session: ClaudeSession,
  selectedLabel: string,
  username: string,
  userId: number,
  chatId: number,
  originalMessage: string
): Promise<void> {
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await sendSystemMessage(
      ctx,
      `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
    );
    return;
  }

  const typing = startTypingIndicator(ctx);
  const state = new StreamingState();
  const statusCallback = await createStatusCallback(ctx, state, session);

  try {
    const response = await session.sendMessageStreaming(
      selectedLabel,
      statusCallback,
      chatId
    );
    await auditLog(userId, username, "DIRECT_INPUT", originalMessage, response);
  } catch (error) {
    console.error(formatErrorForLog(error));

    session.setActivityState("idle");
    cleanupToolMessages(ctx, state.toolMessages);

    if (!(await handleAbortError(ctx, error, session))) {
      await ctx.reply(formatErrorForUser(error));
    }
  } finally {
    state.cleanup();
    typing.stop();
  }
}

async function handleDirectInput(
  ctx: Context,
  session: ClaudeSession,
  chatId: number,
  message: string,
  username: string,
  userId: number
): Promise<boolean> {
  const directInput = session.pendingDirectInput!;

  if (isExpired(directInput.createdAt)) {
    session.clearDirectInput();
    session.clearChoiceState();
    await sendSystemMessage(ctx, "⏱️ Direct input expired (5 min). Please ask again.");
    return true;
  }

  session.clearDirectInput();

  let selectedLabel: string;

  if (directInput.type === "single") {
    selectedLabel = message;
    session.clearChoiceState();
    session.setActivityState("working");
  } else {
    const result = await handleMultiFormInput(
      ctx,
      session,
      chatId,
      directInput,
      message
    );
    if (!result.complete) return true;
    selectedLabel = result.selectedLabel;
  }

  await editMessageSilently(
    ctx,
    chatId,
    directInput.messageId,
    `✓ ${selectedLabel.slice(0, 200)}`
  );
  await sendDirectInputToClaude(
    ctx,
    session,
    selectedLabel,
    username,
    userId,
    chatId,
    message
  );
  return true;
}

export interface DirectInputFlowParams {
  ctx: Context;
  session: ClaudeSession;
  chatId: number;
  message: string;
  username: string;
  userId: number;
}

export async function handlePendingDirectInput(
  params: DirectInputFlowParams
): Promise<boolean> {
  const { ctx, session, chatId, message, username, userId } = params;
  if (!session.pendingDirectInput) {
    return false;
  }
  return handleDirectInput(ctx, session, chatId, message, username, userId);
}

export async function handlePendingParseTextChoice(
  params: DirectInputFlowParams
): Promise<boolean> {
  const { ctx, session, chatId, message, username, userId } = params;
  if (!session.parseTextChoiceState) {
    return false;
  }
  const parseState = session.parseTextChoiceState;

  if (isExpired(parseState.createdAt)) {
    session.clearParseTextChoice();
    await sendSystemMessage(ctx, "⏱️ Choice expired (5 min). Please ask again.");
    return true;
  }

  const numberMatch = message.match(/^(\d+)$/);
  if (!numberMatch) {
    await ctx.reply(
      "❓ Please reply with just the number (e.g., 1, 2, 3). Or ask again."
    );
    return true;
  }

  const choiceNum = parseInt(numberMatch[1]!, 10);
  session.clearParseTextChoice();

  if (parseState.type === "single") {
    const choice = parseState.extractedChoice;
    if (!choice || choiceNum < 1 || choiceNum > choice.choices.length) {
      await ctx.reply(
        `❌ Invalid number. Please choose 1-${choice?.choices.length || 0}.`
      );
      return true;
    }

    const selectedOption = choice.choices[choiceNum - 1]!;
    session.setActivityState("working");

    await sendDirectInputToClaude(
      ctx,
      session,
      selectedOption.label,
      username,
      userId,
      chatId,
      message
    );
    return true;
  }

  await ctx.reply("⚠️ Multi-form text fallback not yet supported. Please try again.");
  return true;
}
