import type { AgentRoute } from "../../routing/resolve-route";
import type { SessionIdentity } from "../../routing/session-key";

export interface ChannelMessageIdentity extends SessionIdentity {
  userId: string;
  messageId: string;
  timestamp: number;
}

export interface ChannelAttachmentRef {
  id: string;
  mimeType?: string;
  name?: string;
}

export interface ChannelInboundEnvelope {
  identity: ChannelMessageIdentity;
  text?: string;
  replyToMessageId?: string;
  locale?: string;
  isInterrupt?: boolean;
  attachments?: ReadonlyArray<ChannelAttachmentRef>;
  metadata?: Readonly<Record<string, unknown>>;
}

interface ChannelOutboundBase {
  route: AgentRoute;
  correlationId?: string;
}

export interface ChannelOutboundTextPayload extends ChannelOutboundBase {
  type: "text";
  text: string;
}

export interface ChannelOutboundStatusPayload extends ChannelOutboundBase {
  type: "status";
  status: "thinking" | "working" | "done" | "error";
  message: string;
}

export interface ChannelOutboundReactionPayload extends ChannelOutboundBase {
  type: "reaction";
  targetMessageId: string;
  reaction: string;
}

export interface ChannelChoiceOption {
  id: string;
  label: string;
  description?: string;
}

export interface ChannelOutboundChoicePayload extends ChannelOutboundBase {
  type: "choice";
  question: string;
  choices: ReadonlyArray<ChannelChoiceOption>;
}

export type ChannelOutboundPayload =
  | ChannelOutboundTextPayload
  | ChannelOutboundStatusPayload
  | ChannelOutboundReactionPayload
  | ChannelOutboundChoicePayload;

export interface ChannelDeliveryReceipt {
  messageId: string;
  deliveredAt: number;
}

export interface ChannelBoundaryCapabilities {
  supportsThreads: boolean;
  supportsReactions: boolean;
  supportsChoiceKeyboard: boolean;
}

export type ChannelBoundaryErrorCode =
  | "CHANNEL_UNAUTHORIZED"
  | "CHANNEL_RATE_LIMITED"
  | "CHANNEL_INVALID_PAYLOAD"
  | "CHANNEL_UNAVAILABLE"
  | "CHANNEL_DELIVERY_FAILED";

export interface ChannelBoundaryError extends Error {
  readonly boundary: "channel";
  readonly code: ChannelBoundaryErrorCode;
  readonly retryable: boolean;
}

export interface ChannelBoundary {
  readonly channelType: string;
  readonly capabilities: ChannelBoundaryCapabilities;
  normalizeInbound(
    rawEvent: unknown
  ): ChannelInboundEnvelope | Promise<ChannelInboundEnvelope>;
  deliverOutbound(payload: ChannelOutboundPayload): Promise<ChannelDeliveryReceipt>;
}
