import type { Context } from "grammy";
import type { ClaudeSession } from "../../core/session/session";
import { sessionManager } from "../../core/session/session-manager";
import { TelegramChoiceBuilder } from "../../utils/telegram-choice-builder";
import { sendSystemMessage } from "../../utils/system-message";
import { checkInterrupt } from "../../utils/interrupt";
import { Reactions } from "../../constants/reactions";

export interface InterruptRouteParams {
  ctx: Context;
  session: ClaudeSession;
  message: string;
  chatId: number;
  threadId?: number;
  deliverInboundReaction: (reaction: string) => Promise<void>;
}

export interface InterruptRouteResult {
  handled: boolean;
  message: string;
  wasInterrupt: boolean;
}

export async function runInterruptRoute(
  params: InterruptRouteParams
): Promise<InterruptRouteResult> {
  const { ctx, session, message, chatId, threadId, deliverInboundReaction } = params;
  const wasInterrupt = message.startsWith("!");
  const nextMessage = await checkInterrupt(message, session);

  if (nextMessage.trim()) {
    return { handled: false, message: nextMessage, wasInterrupt };
  }

  if (!wasInterrupt) {
    return { handled: true, message: nextMessage, wasInterrupt };
  }

  const lostMessages = session.extractSteeringMessages();
  if (lostMessages.length > 0) {
    const sessionKey = sessionManager.deriveKey(chatId, threadId);
    session.setPendingRecovery(lostMessages, chatId);

    const keyboard = TelegramChoiceBuilder.buildLostMessageKeyboard(sessionKey);
    const messageText = TelegramChoiceBuilder.buildLostMessageText(lostMessages, true);

    try {
      const sentMsg = await ctx.reply(messageText, {
        reply_markup: keyboard,
        parse_mode: "Markdown",
      });
      session.setPendingRecovery(lostMessages, chatId, sentMsg.message_id);
    } catch (replyError) {
      console.error("[INTERRUPT] Failed to send lost message UI:", replyError);
      try {
        await sendSystemMessage(ctx, "🛑 Stopped (had undelivered messages)");
      } catch {}
    }
    return { handled: true, message: nextMessage, wasInterrupt };
  }

  try {
    await sendSystemMessage(ctx, "🛑 Stopped");
  } catch {
    try {
      await deliverInboundReaction(Reactions.INTERRUPTED);
    } catch {}
  }
  return { handled: true, message: nextMessage, wasInterrupt };
}

export interface SteeringGateParams {
  ctx: Context;
  session: ClaudeSession;
  message: string;
  wasInterrupt: boolean;
  chatId: number;
  userId: number;
  username: string;
  deliverInboundReaction: (reaction: string) => Promise<void>;
}

export async function handleSteeringGate(params: SteeringGateParams): Promise<boolean> {
  const {
    ctx,
    session,
    message,
    wasInterrupt,
    chatId,
    userId,
    username,
    deliverInboundReaction,
  } = params;
  if (!session.isProcessing) {
    return false;
  }

  console.log(
    `[STEERING] Message gated by isProcessing=true, queryState=${session.queryState}, msg="${message.slice(0, 50)}"`
  );

  if (wasInterrupt) {
    const start = Date.now();
    while (session.isProcessing && Date.now() - start < 2000) {
      await Bun.sleep(50);
    }
    return false;
  }

  const messageId = ctx.message?.message_id;
  const steeringContext = {
    chatId,
    userId,
    username,
    messageId,
    currentTool: session.currentTool,
    hasSteeringMessages: session.hasSteeringMessages(),
    timestamp: new Date().toISOString(),
  };

  if (messageId === undefined) {
    console.error("[STEERING] CRITICAL: Missing message_id, cannot buffer steering", {
      ...steeringContext,
      messagePreview: message.slice(0, 100),
    });
    try {
      await ctx.reply(
        "⚠️ Unable to queue message (technical issue: missing message ID). Please try sending again."
      );
    } catch (replyError) {
      console.error(
        "Failed to notify user of missing message_id:",
        replyError,
        steeringContext
      );
      try {
        await deliverInboundReaction(Reactions.ERROR_SOMA);
      } catch {}
    }
    return true;
  }

  const evicted = session.addSteering(
    message,
    messageId,
    session.currentTool || undefined
  );

  if (evicted) {
    console.warn("[STEERING] Buffer full, oldest message evicted", {
      ...steeringContext,
      bufferSize: 20,
    });

    let notified = false;
    try {
      await ctx.reply(
        "⚠️ **Message Queue Full**\n\nYour oldest queued message was dropped because Claude is very busy. Please wait for current task to complete."
      );
      notified = true;
    } catch (replyError) {
      console.error("Failed to notify via reply:", replyError, steeringContext);
      try {
        await deliverInboundReaction(Reactions.CANCELLED);
        notified = true;
      } catch (reactError) {
        console.error("Failed to notify via reaction:", reactError, steeringContext);
      }
    }

    if (!notified) {
      console.error("[STEERING] CRITICAL: Could not notify user of message eviction", {
        ...steeringContext,
      });
    }
  } else {
    console.log("[STEERING] Buffered user message during execution", steeringContext);
    try {
      await deliverInboundReaction(Reactions.STEERING_BUFFERED);
    } catch (error) {
      console.debug("Failed to add steering reaction:", error, steeringContext);
    }
  }

  return true;
}

export interface RecoveryParams {
  ctx: Context;
  session: ClaudeSession;
  chatId: number;
}

export async function resolvePendingRecoveryContext(
  params: RecoveryParams
): Promise<void> {
  const { ctx, session, chatId } = params;
  if (!session.hasPendingRecovery()) {
    return;
  }
  const recovery = session.getPendingRecovery();
  if (!recovery) {
    return;
  }

  console.log(
    `[RECOVERY] Auto-resolving pending recovery (${recovery.messages.length} messages) as context for new message`
  );

  const resolved = session.resolvePendingRecovery();
  if (resolved && resolved.length > 0) {
    const formattedContext = resolved
      .map((message) => {
        const ts = new Date(message.timestamp).toLocaleTimeString("en-US", {
          hour12: false,
        });
        return `[${ts}] ${message.content}`;
      })
      .join("\n");
    session.nextQueryContext = `[CONTEXT FROM INTERRUPTED SESSION - ${resolved.length} message(s)]\n${formattedContext}\n[END CONTEXT]`;
  }

  if (recovery.messageId) {
    try {
      await ctx.api.deleteMessage(chatId, recovery.messageId);
    } catch (deleteError) {
      console.debug("[RECOVERY] Failed to delete inline button message:", deleteError);
    }
  }

  try {
    await sendSystemMessage(ctx, "📋 Previous messages added as context.");
  } catch {}
}
