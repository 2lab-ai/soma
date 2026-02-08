import { describe, expect, test } from "bun:test";
import type { ChannelBoundary, ChannelOutboundPayload } from "./plugins/types.core";
import { ChannelOutboundOrchestrator } from "./outbound-orchestrator";
import { buildSessionKey, buildStoragePartitionKey, createSessionIdentity } from "../routing/session-key";
import type { AgentRoute } from "../routing/resolve-route";

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

describe("ChannelOutboundOrchestrator", () => {
  test("routes text/status/reaction/choice through one dispatch path", async () => {
    const seen: ChannelOutboundPayload[] = [];
    const boundary: ChannelBoundary = {
      channelType: "telegram",
      capabilities: {
        supportsThreads: true,
        supportsReactions: true,
        supportsChoiceKeyboard: true,
      },
      normalizeInbound: async () => {
        throw new Error("not used");
      },
      deliverOutbound: async (payload) => {
        seen.push(payload);
        return { messageId: `m-${seen.length}`, deliveredAt: Date.now() };
      },
    };

    const route = buildRoute();
    const orchestrator = new ChannelOutboundOrchestrator(boundary);

    await orchestrator.sendText(route, "hello");
    await orchestrator.sendStatus(route, "working", "processing");
    await orchestrator.sendReaction(route, "123", "👌");
    await orchestrator.sendChoice(route, {
      question: "Pick one",
      choices: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
      ],
    });

    expect(seen).toHaveLength(4);
    expect(seen[0]?.type).toBe("text");
    expect(seen[1]?.type).toBe("text");
    expect((seen[1] as { text?: string }).text).toBe("processing");
    expect(seen[2]?.type).toBe("reaction");
    expect(seen[3]?.type).toBe("text");
    expect((seen[3] as { text?: string }).text).toContain("Pick one");
    expect((seen[3] as { text?: string }).text).toContain("1. Alpha");
  });
});
