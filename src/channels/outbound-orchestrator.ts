import type { AgentRoute } from "../routing/resolve-route";
import type {
  ChannelBoundary,
  ChannelDeliveryReceipt,
  ChannelOutboundChoicePayload,
  ChannelOutboundPayload,
} from "./plugins/types.core";
import { normalizePayload } from "./outbound/normalize-payload";
import { renderChoicePayload } from "./outbound/render-choice";

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
    payload: Pick<
      ChannelOutboundChoicePayload,
      "question" | "choices" | "correlationId"
    >
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
