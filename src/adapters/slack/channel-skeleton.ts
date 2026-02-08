import type {
  ChannelBoundary,
  ChannelBoundaryError,
  ChannelBoundaryErrorCode,
  ChannelDeliveryReceipt,
  ChannelInboundEnvelope,
  ChannelOutboundPayload,
  ChannelMessageIdentity,
} from "../../channels/plugins/types.core";
import { createSessionIdentity } from "../../routing/session-key";

const DEFAULT_CHANNEL_TYPE = "slack";

export interface SlackSkeletonInboundRawEvent {
  teamId: string;
  channelId: string;
  threadTs?: string;
  userId: string;
  text: string;
  ts: string;
  eventId?: string;
  tenantId?: string;
}

export interface SlackSkeletonInboundEnvelope extends ChannelInboundEnvelope {
  metadata: {
    teamId: string;
    slackChannelId: string;
    slackThreadTs?: string;
    slackEventId?: string;
  };
}

interface SlackSkeletonOutboundPort {
  sendText(channelId: string, text: string, threadTs?: string): Promise<string>;
  sendReaction(channelId: string, timestamp: string, reaction: string): Promise<void>;
}

class SlackSkeletonBoundaryError extends Error implements ChannelBoundaryError {
  readonly boundary = "channel" as const;
  readonly code: ChannelBoundaryErrorCode;
  readonly retryable: boolean;

  constructor(
    code: ChannelBoundaryErrorCode,
    message: string,
    retryable: boolean = false
  ) {
    super(message);
    this.name = "SlackSkeletonBoundaryError";
    this.code = code;
    this.retryable = retryable;
  }
}

function sanitizeThreadIdentity(threadTs?: string, messageTs?: string): string {
  return threadTs || messageTs || "main";
}

function parseSlackTimestamp(ts: string): number {
  const timestamp = Number(ts);
  if (!Number.isFinite(timestamp)) {
    return Date.now();
  }
  return Math.floor(timestamp * 1000);
}

function parseAllowlist(allowedTenants: ReadonlyArray<string> | null): Set<string> {
  if (!allowedTenants || allowedTenants.length === 0) {
    return new Set();
  }
  return new Set(allowedTenants.map((tenant) => tenant.trim()).filter(Boolean));
}

export class SlackSkeletonChannelBoundary implements ChannelBoundary {
  readonly channelType = DEFAULT_CHANNEL_TYPE;
  readonly capabilities = {
    supportsThreads: true,
    supportsReactions: true,
    supportsChoiceKeyboard: false,
  };

  private readonly tenantAllowlist: Set<string>;
  private readonly outboundPort: SlackSkeletonOutboundPort | null;

  constructor(options?: {
    allowedTenants?: ReadonlyArray<string> | null;
    outboundPort?: SlackSkeletonOutboundPort;
  }) {
    this.tenantAllowlist = parseAllowlist(options?.allowedTenants ?? null);
    this.outboundPort = options?.outboundPort ?? null;
  }

  normalizeInbound(rawEvent: unknown): SlackSkeletonInboundEnvelope {
    const event = rawEvent as SlackSkeletonInboundRawEvent;
    if (
      !event?.teamId ||
      !event?.channelId ||
      !event?.userId ||
      !event?.text ||
      !event?.ts
    ) {
      throw new SlackSkeletonBoundaryError(
        "CHANNEL_INVALID_PAYLOAD",
        "Slack skeleton payload missing required fields."
      );
    }

    const tenantId = event.tenantId ?? event.teamId;
    if (!tenantId) {
      throw new SlackSkeletonBoundaryError(
        "CHANNEL_INVALID_PAYLOAD",
        "Tenant identity is required for slack skeleton."
      );
    }

    if (this.tenantAllowlist.size > 0 && !this.tenantAllowlist.has(tenantId)) {
      throw new SlackSkeletonBoundaryError(
        "CHANNEL_UNAUTHORIZED",
        `Tenant ${tenantId} is not allowed by slack boundary.`
      );
    }

    const identity = createSessionIdentity({
      tenantId,
      channelId: `slack-${event.channelId}`,
      threadId: sanitizeThreadIdentity(event.threadTs, event.ts),
    });

    const messageIdentity: ChannelMessageIdentity = {
      ...identity,
      userId: event.userId,
      messageId: event.eventId || event.ts,
      timestamp: parseSlackTimestamp(event.ts),
    };

    return {
      identity: messageIdentity,
      text: event.text,
      metadata: {
        teamId: event.teamId,
        slackChannelId: event.channelId,
        slackThreadTs: event.threadTs,
        slackEventId: event.eventId,
      },
    };
  }

  async deliverOutbound(payload: ChannelOutboundPayload): Promise<ChannelDeliveryReceipt> {
    if (!this.outboundPort) {
      // Skeleton mode: compile-time contract only, runtime is intentionally no-op unless wired.
      return {
        messageId: "slack-skeleton-noop",
        deliveredAt: Date.now(),
      };
    }

    const channelId = payload.route.identity.channelId.replace(/^slack-/, "");
    const threadTs =
      payload.route.identity.threadId === "main" ? undefined : payload.route.identity.threadId;

    if (payload.type === "reaction") {
      await this.outboundPort.sendReaction(channelId, payload.targetMessageId, payload.reaction);
      return {
        messageId: payload.targetMessageId,
        deliveredAt: Date.now(),
      };
    }

    if (payload.type === "text") {
      const messageId = await this.outboundPort.sendText(channelId, payload.text, threadTs);
      return {
        messageId,
        deliveredAt: Date.now(),
      };
    }

    throw new SlackSkeletonBoundaryError(
      "CHANNEL_INVALID_PAYLOAD",
      `Unsupported slack outbound type: ${(payload as { type: string }).type}`
    );
  }
}

export function loadSlackSkeletonBoundaryFromEnv(): SlackSkeletonChannelBoundary | null {
  if (process.env.SLACK_SKELETON_ENABLED !== "true") {
    return null;
  }

  const allowlist = (process.env.SLACK_ALLOWED_TENANTS || "")
    .split(",")
    .map((tenant) => tenant.trim())
    .filter(Boolean);

  return new SlackSkeletonChannelBoundary({
    allowedTenants: allowlist.length > 0 ? allowlist : null,
  });
}
