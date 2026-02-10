import type { Context } from "grammy";
import type {
  ChannelBoundary,
  ChannelBoundaryError,
  ChannelBoundaryErrorCode,
  ChannelDeliveryReceipt,
  ChannelInboundEnvelope,
  ChannelOutboundPayload,
  ChannelMessageIdentity,
} from "../../channels/plugins/types.core";
import type { AgentRoute } from "../../core/routing/resolve-route";
import {
  buildSessionKey,
  buildStoragePartitionKey,
  createSessionIdentity,
} from "../../core/routing/session-key";
import { type ChatType } from "../../security";
import {
  type TelegramAuthPolicy,
  type TelegramAuthorizeFn,
  createTelegramAuthPolicy,
} from "./auth-policy";
import { type TelegramOrderPolicy, createTelegramOrderPolicy } from "./order-policy";
import { type TelegramOutboundPort, createTelegramOutboundPort } from "./outbound-port";
import {
  type TelegramRateLimitPolicy,
  type TelegramRateLimitFn,
  createTelegramRateLimitPolicy,
} from "./rate-limit-policy";

const TELEGRAM_MAIN_THREAD_ID = "main";

export interface TelegramBoundaryRawInbound {
  ctx: Context;
  tenantId?: string;
}

export interface TelegramNormalizedInboundEnvelope extends ChannelInboundEnvelope {
  metadata: {
    chatId: number;
    threadId?: number;
    chatType?: ChatType;
    username: string;
    retryAfterSeconds?: number;
    interruptBypassApplied?: boolean;
  };
}

class TelegramBoundaryError extends Error implements ChannelBoundaryError {
  readonly boundary = "channel" as const;
  readonly retryable: boolean;
  readonly code: ChannelBoundaryErrorCode;
  readonly metadata?: Record<string, unknown>;

  constructor(
    code: ChannelBoundaryErrorCode,
    message: string,
    retryable: boolean = false,
    metadata?: Record<string, unknown>
  ) {
    super(message);
    this.name = "TelegramBoundaryError";
    this.code = code;
    this.retryable = retryable;
    this.metadata = metadata;
  }
}

function toThreadIdentity(threadId?: number): string {
  if (!threadId || threadId === 1) {
    return TELEGRAM_MAIN_THREAD_ID;
  }
  return String(threadId);
}

function toNumber(value: string, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new TelegramBoundaryError(
      "CHANNEL_INVALID_PAYLOAD",
      `Invalid numeric ${fieldName}: ${value}`
    );
  }
  return parsed;
}

export function isTelegramBoundaryError(
  error: unknown
): error is TelegramBoundaryError {
  return error instanceof TelegramBoundaryError;
}

export function buildTelegramAgentRoute(
  inbound: TelegramNormalizedInboundEnvelope
): AgentRoute {
  return {
    identity: inbound.identity,
    sessionKey: buildSessionKey(inbound.identity),
    storagePartitionKey: buildStoragePartitionKey(inbound.identity),
    accountId: inbound.identity.userId,
    peer: inbound.identity.channelId,
    parentPeer:
      inbound.identity.threadId === TELEGRAM_MAIN_THREAD_ID
        ? undefined
        : inbound.identity.threadId,
    providerId: "anthropic",
  };
}

export class TelegramChannelBoundary implements ChannelBoundary {
  readonly channelType = "telegram";
  readonly capabilities = {
    supportsThreads: true,
    supportsReactions: true,
    supportsChoiceKeyboard: true,
  };

  private readonly authPolicy: TelegramAuthPolicy;
  private readonly rateLimitPolicy: TelegramRateLimitPolicy;
  private readonly orderPolicy: TelegramOrderPolicy;
  private readonly outboundPort: TelegramOutboundPort | null;

  constructor(options?: {
    authorize?: TelegramAuthorizeFn;
    checkRateLimit?: TelegramRateLimitFn;
    outboundPort?: TelegramOutboundPort;
    authPolicy?: TelegramAuthPolicy;
    rateLimitPolicy?: TelegramRateLimitPolicy;
    orderPolicy?: TelegramOrderPolicy;
  }) {
    this.authPolicy =
      options?.authPolicy ?? createTelegramAuthPolicy(options?.authorize);
    this.rateLimitPolicy =
      options?.rateLimitPolicy ??
      createTelegramRateLimitPolicy(options?.checkRateLimit);
    this.orderPolicy = options?.orderPolicy ?? createTelegramOrderPolicy();
    this.outboundPort = options?.outboundPort ?? null;
  }

  normalizeInbound(rawEvent: unknown): TelegramNormalizedInboundEnvelope {
    const event = rawEvent as TelegramBoundaryRawInbound;
    const ctx = event?.ctx;
    const text = ctx?.message?.text;
    const userId = ctx?.from?.id;
    const username = ctx?.from?.username || "unknown";
    const chatId = ctx?.chat?.id;
    const chatType = ctx?.chat?.type as ChatType | undefined;
    const threadId = ctx?.message?.message_thread_id;
    const messageId = ctx?.message?.message_id;
    const timestampSeconds = ctx?.message?.date;

    if (!ctx || !text || !userId || !chatId || !messageId || !timestampSeconds) {
      throw new TelegramBoundaryError(
        "CHANNEL_INVALID_PAYLOAD",
        "Telegram message payload is incomplete."
      );
    }

    const authDecision = this.authPolicy.evaluate({ userId, chatId, chatType });
    if (!authDecision.authorized) {
      throw new TelegramBoundaryError(
        "CHANNEL_UNAUTHORIZED",
        "Unauthorized chat/user for telegram boundary."
      );
    }

    const rateLimitDecision = this.rateLimitPolicy.evaluate({ userId });
    if (!rateLimitDecision.allowed) {
      throw new TelegramBoundaryError(
        "CHANNEL_RATE_LIMITED",
        "Inbound rate limit exceeded.",
        true,
        { retryAfterSeconds: rateLimitDecision.retryAfterSeconds }
      );
    }

    const timestampMs = timestampSeconds * 1000;
    const isInterrupt = text.trimStart().startsWith("!");
    const orderingDecision = this.orderPolicy.evaluate({
      chatId,
      threadId,
      timestampMs,
      text,
    });
    if (!orderingDecision.accepted) {
      throw new TelegramBoundaryError(
        "CHANNEL_INVALID_PAYLOAD",
        "Out-of-order telegram message dropped by boundary policy."
      );
    }

    const identity = createSessionIdentity({
      tenantId: event.tenantId ?? "default",
      channelId: String(chatId),
      threadId: toThreadIdentity(threadId),
    });

    const messageIdentity: ChannelMessageIdentity = {
      ...identity,
      userId: String(userId),
      messageId: String(messageId),
      timestamp: timestampMs,
    };

    return {
      identity: messageIdentity,
      text,
      isInterrupt,
      metadata: {
        chatId,
        threadId,
        chatType,
        username,
        retryAfterSeconds: rateLimitDecision.retryAfterSeconds,
        interruptBypassApplied: orderingDecision.interruptBypassApplied,
      },
    };
  }

  async deliverOutbound(
    payload: ChannelOutboundPayload
  ): Promise<ChannelDeliveryReceipt> {
    if (!this.outboundPort) {
      throw new TelegramBoundaryError(
        "CHANNEL_UNAVAILABLE",
        "Outbound port is not configured for telegram boundary."
      );
    }

    const chatId = toNumber(payload.route.identity.channelId, "chatId");
    const deliveredAt = Date.now();

    if (payload.type === "reaction") {
      await this.outboundPort.sendReaction(
        chatId,
        toNumber(payload.targetMessageId, "targetMessageId"),
        payload.reaction
      );
      return {
        messageId: payload.targetMessageId,
        deliveredAt,
      };
    }

    if (payload.type === "text") {
      const messageId = await this.outboundPort.sendText(chatId, payload.text);
      return {
        messageId: String(messageId),
        deliveredAt,
      };
    }

    throw new TelegramBoundaryError(
      "CHANNEL_INVALID_PAYLOAD",
      `Unsupported outbound payload type: ${(payload as { type: string }).type}`
    );
  }
}

export function createTelegramBoundaryWithContext(
  ctx: Context
): TelegramChannelBoundary {
  return new TelegramChannelBoundary({
    outboundPort: createTelegramOutboundPort(ctx),
  });
}
