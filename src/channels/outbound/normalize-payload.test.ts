import { describe, expect, test } from "bun:test";
import type {
  ChannelOutboundPayload,
  ChannelOutboundReactionPayload,
  ChannelOutboundTextPayload,
} from "../plugins/types.core";
import { normalizePayload } from "./normalize-payload";
import {
  buildSessionKey,
  buildStoragePartitionKey,
  createSessionIdentity,
} from "../../routing/session-key";
import type { AgentRoute } from "../../routing/resolve-route";

function buildRoute(): AgentRoute {
  const identity = createSessionIdentity({
    tenantId: "tenant-a",
    channelId: "telegram-main",
    threadId: "thread-1",
  });

  return {
    identity,
    sessionKey: buildSessionKey(identity),
    storagePartitionKey: buildStoragePartitionKey(identity),
    accountId: "user-1",
    peer: identity.channelId,
    providerId: "anthropic",
  };
}

describe("normalizePayload", () => {
  test("transforms status payload to text payload and preserves correlationId", () => {
    const route = buildRoute();
    const normalized = normalizePayload({
      type: "status",
      route,
      status: "working",
      message: "processing",
      correlationId: "corr-status",
    });

    expect(normalized).toEqual({
      type: "text",
      route,
      text: "processing",
      correlationId: "corr-status",
    });
  });

  test("transforms choice payload to text payload and preserves correlationId", () => {
    const route = buildRoute();
    const normalized = normalizePayload({
      type: "choice",
      route,
      question: "Pick one",
      choices: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
      ],
      correlationId: "corr-choice",
    });

    expect(normalized.type).toBe("text");
    expect((normalized as { text?: string }).text).toContain("Pick one");
    expect((normalized as { text?: string }).text).toContain("1. Alpha");
    expect((normalized as { text?: string }).text).toContain("2. Beta");
    expect((normalized as { correlationId?: string }).correlationId).toBe(
      "corr-choice"
    );
  });

  test("keeps text payload unchanged", () => {
    const textPayload: ChannelOutboundTextPayload = {
      type: "text",
      route: buildRoute(),
      text: "hello",
      correlationId: "corr-text",
    };

    const normalized = normalizePayload(textPayload);
    expect(normalized).toBe(textPayload);
  });

  test("keeps reaction payload unchanged", () => {
    const reactionPayload: ChannelOutboundReactionPayload = {
      type: "reaction",
      route: buildRoute(),
      targetMessageId: "10",
      reaction: "👌",
      correlationId: "corr-reaction",
    };

    const normalized = normalizePayload(
      reactionPayload as ChannelOutboundPayload
    ) as ChannelOutboundReactionPayload;

    expect(normalized).toBe(reactionPayload);
  });
});
