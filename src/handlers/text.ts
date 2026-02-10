/**
 * Text message handler for Claude Telegram Bot.
 */

import type { Context } from "grammy";
import { Reactions } from "../constants/reactions";
import { type ChatType } from "../security";
import { sessionManager } from "../core/session/session-manager";
import {
  handlePendingDirectInput,
  handlePendingParseTextChoice,
} from "./text/direct-input-flow";
import { runInboundGuard } from "./text/inbound-guard";
import {
  handleSteeringGate,
  resolvePendingRecoveryContext,
  runInterruptRoute,
} from "./text/interrupt-flow";
import { runQueryFlow } from "./text/query-flow";

// Bot username (set by index.ts after bot info is fetched)
export let botUsername = "";
export function setBotUsername(username: string): void {
  botUsername = username;
}

/**
 * Handle incoming text messages.
 */
export async function handleText(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type as ChatType | undefined;
  const threadId = ctx.message?.message_thread_id;
  let message = ctx.message?.text;

  if (!userId || !message || !chatId) {
    return;
  }

  const inbound = await runInboundGuard({
    ctx,
    message,
    chatType,
    userId,
    username,
    botUsername,
  });
  if (!inbound) {
    return;
  }

  message = inbound.normalizedMessage;
  const { deliverInboundReaction } = inbound;

  try {
    await deliverInboundReaction(Reactions.READ);
  } catch (error) {
    console.debug("Failed to add reaction to user message via boundary:", error);
  }

  const session = sessionManager.getSession(chatId, threadId);

  const directInputHandled = await handlePendingDirectInput({
    ctx,
    session,
    chatId,
    message,
    username,
    userId,
  });
  if (directInputHandled) {
    return;
  }

  const parseTextChoiceHandled = await handlePendingParseTextChoice({
    ctx,
    session,
    chatId,
    message,
    username,
    userId,
  });
  if (parseTextChoiceHandled) {
    return;
  }

  const interruptResult = await runInterruptRoute({
    ctx,
    session,
    message,
    chatId,
    threadId,
    deliverInboundReaction,
  });
  if (interruptResult.handled) {
    return;
  }

  message = interruptResult.message;
  const { wasInterrupt } = interruptResult;

  // Strip @mention from message if present (cleaner input for Claude)
  if (botUsername && message.includes(`@${botUsername}`)) {
    message = message.replace(new RegExp(`@${botUsername}\\s*`, "g"), "").trim();
  }

  const steeringHandled = await handleSteeringGate({
    ctx,
    session,
    message,
    wasInterrupt,
    chatId,
    userId,
    username,
    deliverInboundReaction,
  });
  if (steeringHandled) {
    return;
  }

  await resolvePendingRecoveryContext({
    ctx,
    session,
    chatId,
  });

  await runQueryFlow({
    ctx,
    session,
    message,
    chatId,
    userId,
    username,
    deliverInboundReaction,
  });
}
