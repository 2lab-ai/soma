import type { ChannelOutboundChoicePayload } from "../plugins/types.core";

export function renderChoicePayload(payload: ChannelOutboundChoicePayload): string {
  return [
    payload.question,
    "",
    ...payload.choices.map((choice, index) => `${index + 1}. ${choice.label}`),
  ].join("\n");
}
