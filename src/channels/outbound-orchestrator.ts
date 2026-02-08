import type { AgentRoute } from "../routing/resolve-route";
import type {
  ChannelBoundary,
  ChannelDeliveryReceipt,
  ChannelOutboundChoicePayload,
  ChannelOutboundPayload,
} from "./plugins/types.core";

function renderChoicePayload(payload: ChannelOutboundChoicePayload): string {
  return [
    payload.question,
    "",
    ...payload.choices.map((choice, index) => `${index + 1}. ${choice.label}`),
  ].join("\n");
}

function normalizePayload(payload: ChannelOutboundPayload): ChannelOutboundPayload {
  if (payload.type === "status") {
    return {
      type: "text",
      route: payload.route,
      text: payload.message,
      correlationId: payload.correlationId,
    };
  }

  if (payload.type === "choice") {
    return {
      type: "text",
      route: payload.route,
      text: renderChoicePayload(payload),
      correlationId: payload.correlationId,
    };
  }

  return payload;
}

export class ChannelOutboundOrchestrator {
  constructor(private readonly boundary: ChannelBoundary) {}

  async dispatch(payload: ChannelOutboundPayload): Promise<ChannelDeliveryReceipt> {
    return this.boundary.deliverOutbound(normalizePayload(payload));
  }

  async sendText(
    route: AgentRoute,
    text: string,
    correlationId?: string
  ): Promise<ChannelDeliveryReceipt> {
    return this.dispatch({ type: "text", route, text, correlationId });
  }

  async sendStatus(
    route: AgentRoute,
    status: "thinking" | "working" | "done" | "error",
    message: string,
    correlationId?: string
  ): Promise<ChannelDeliveryReceipt> {
    return this.dispatch({
      type: "status",
      route,
      status,
      message,
      correlationId,
    });
  }

  async sendReaction(
    route: AgentRoute,
    targetMessageId: string,
    reaction: string,
    correlationId?: string
  ): Promise<ChannelDeliveryReceipt> {
    return this.dispatch({
      type: "reaction",
      route,
      targetMessageId,
      reaction,
      correlationId,
    });
  }

  async sendChoice(
    route: AgentRoute,
    payload: Pick<ChannelOutboundChoicePayload, "question" | "choices" | "correlationId">
  ): Promise<ChannelDeliveryReceipt> {
    return this.dispatch({
      type: "choice",
      route,
      question: payload.question,
      choices: payload.choices,
      correlationId: payload.correlationId,
    });
  }
}

export { renderChoicePayload };
