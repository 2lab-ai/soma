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
import { runQueryFlow, type QueryFlowParams } from "./text/query-flow";
import { MessageQueue } from "../message-queue";
import { handleNaturalLanguageSkills } from "./text/skills-nl";

// Bot username (set by index.ts after bot info is fetched)
export let botUsername = "";
export function setBotUsername(username: string): void {
  botUsername = username;
}

// ─── Pre-execution Message Batching ───────────────────────────────────
// When session is idle, batch rapid-fire messages via MessageQueue
// so they hit Claude as a single combined prompt instead of N separate calls.

const DEBOUNCE_MS = 500;

interface PendingBatch {
  queue: MessageQueue;
  /** Most recent params — used for ctx, session, chatId etc. on flush */
  latestParams: QueryFlowParams;
  /** All enqueued messages in order */
  messages: string[];
}

const pendingBatches = new Map<string, PendingBatch>();

function getSessionKey(chatId: number, threadId?: number): string {
  return threadId ? `${chatId}:${threadId}` : String(chatId);
}

async function flushBatch(key: string): Promise<void> {
  const batch = pendingBatches.get(key);
  if (!batch) return;

  // Grab and clear
  const messages = [...batch.messages];
  const params = batch.latestParams;
  pendingBatches.delete(key);

  if (messages.length === 0) return;

  const combined: string = messages.length === 1
    ? messages[0]!
    : messages.map((m, i) => `[${i + 1}] ${m}`).join("\n");

  console.log(
    `[BATCH] Flushing ${messages.length} message(s) for ${key}: "${combined.slice(0, 100)}..."`
  );

  try {
    await resolvePendingRecoveryContext({
      ctx: params.ctx,
      session: params.session,
      chatId: params.chatId,
    });

    await runQueryFlow({
      ...params,
      message: combined,
    });
  } catch (error) {
    const errorStr = error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
    console.error(`[BATCH] Unhandled error during flush for ${key}:`, error);

    // Notify user
    try {
      await params.ctx.reply(
        `❌ **Error processing message**\n\n\`\`\`\n${errorStr.slice(0, 600)}\n\`\`\``,
        { parse_mode: "Markdown" }
      );
    } catch {
      await params.ctx.reply(
        `❌ Error processing message\n\n${errorStr.slice(0, 600)}`
      ).catch(() => {});
    }
  }
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

  // ─── Natural language skills management ──────────────────────────
  // Intercept "add X to skills menu", "remove X from skills menu", etc.
  // Handled locally without Claude API call.
  const skillsHandled = await handleNaturalLanguageSkills(ctx, message);
  if (skillsHandled) {
    return;
  }

  // ─── Pre-execution batching ───────────────────────────────────────
  // If session is idle, batch rapid-fire messages via debounce window.
  // If session is processing, steering gate already handled it above.

  const threadId2 = ctx.message?.message_thread_id;
  const batchKey = getSessionKey(chatId, threadId2);

  const queryParams: QueryFlowParams = {
    ctx,
    session,
    message,
    chatId,
    userId,
    username,
    deliverInboundReaction,
  };

  const existing = pendingBatches.get(batchKey);
  if (existing) {
    // Additional message within debounce window — append
    existing.messages.push(message);
    existing.latestParams = queryParams;
    // Re-enqueue resets the debounce timer inside MessageQueue
    existing.queue.enqueue(message);
    console.log(
      `[BATCH] Appended message #${existing.messages.length} for ${batchKey}: "${message.slice(0, 60)}"`
    );
    return;
  }

  // First message — create batch with debounce
  const batchState: PendingBatch = {
    queue: new MessageQueue({
      debounceMs: DEBOUNCE_MS,
      onFlush: () => flushBatch(batchKey),
      onError: (err) => console.error(`[BATCH] Flush error for ${batchKey}:`, err),
    }),
    latestParams: queryParams,
    messages: [message],
  };
  pendingBatches.set(batchKey, batchState);
  batchState.queue.enqueue(message);

  console.log(
    `[BATCH] Started batch for ${batchKey}, debounce=${DEBOUNCE_MS}ms: "${message.slice(0, 60)}"`
  );
}
