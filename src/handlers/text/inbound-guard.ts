import type { Context } from "grammy";
import { type ChatType, shouldRespond } from "../../security";
import { auditLogRateLimit } from "../../utils/audit";
import { sendSystemMessage } from "../../utils/system-message";
import {
  buildTelegramAgentRoute,
  createTelegramBoundaryWithContext,
  isTelegramBoundaryError,
} from "../../adapters/telegram/channel-boundary";
import { ChannelOutboundOrchestrator } from "../../channels/outbound-orchestrator";

export interface InboundGuardParams {
  ctx: Context;
  message: string;
  chatType: ChatType | undefined;
  userId: number;
  username: string;
  botUsername: string;
}

export interface InboundGuardResult {
  normalizedMessage: string;
  deliverInboundReaction: (reaction: string) => Promise<void>;
}

export async function runInboundGuard(
  params: InboundGuardParams
): Promise<InboundGuardResult | null> {
  const { ctx, message, chatType, userId, username, botUsername } = params;
  const isReplyToBot = Boolean(
    ctx.message?.reply_to_message?.from?.is_bot &&
    ctx.message?.reply_to_message?.from?.username === botUsername
  );
  if (!shouldRespond(chatType, message, botUsername, isReplyToBot)) {
    return null;
  }

  const boundary = createTelegramBoundaryWithContext(ctx);
  let inbound;
  try {
    inbound = boundary.normalizeInbound({
      ctx,
      tenantId: "default",
    });
  } catch (error) {
    if (!isTelegramBoundaryError(error)) {
      throw error;
    }
    if (error.code === "CHANNEL_UNAUTHORIZED") {
      if (chatType === "private") {
        await ctx.reply("Unauthorized. Contact the bot owner for access.");
      }
      return null;
    }
    if (error.code === "CHANNEL_RATE_LIMITED") {
      const retryAfter = Number(
        (error as { metadata?: { retryAfterSeconds?: number } }).metadata
          ?.retryAfterSeconds ?? 1
      );
      await auditLogRateLimit(userId, username, retryAfter);
      await sendSystemMessage(
        ctx,
        `⏳ Rate limited. Please wait ${retryAfter.toFixed(1)} seconds.`
      );
      return null;
    }
    if (error.code === "CHANNEL_INVALID_PAYLOAD") {
      return null;
    }
    throw error;
  }

  const outboundRoute = buildTelegramAgentRoute(inbound);
  const outbound = new ChannelOutboundOrchestrator(boundary);
  const deliverInboundReaction = async (reaction: string): Promise<void> => {
    await outbound.sendReaction(outboundRoute, inbound.identity.messageId, reaction);
  };

  return {
    normalizedMessage: inbound.text || message,
    deliverInboundReaction,
  };
}
