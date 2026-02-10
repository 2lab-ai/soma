import type { ChannelOutboundPayload } from "../plugins/types.core";
import { renderChoicePayload } from "./render-choice";

export function normalizePayload(
  payload: ChannelOutboundPayload
): ChannelOutboundPayload {
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
