import { afterEach, describe, expect, test } from "bun:test";
import { buildSessionKey, buildStoragePartitionKey } from "../../routing/session-key";
import type { AgentRoute } from "../../routing/resolve-route";
import type { ChannelOutboundPayload } from "../../channels/plugins/types.core";
import { ChannelOutboundOrchestrator } from "../../channels/outbound-orchestrator";
import {
  SlackSkeletonChannelBoundary,
  loadSlackSkeletonBoundaryFromEnv,
} from "./channel-skeleton";

function buildRoute(identity: ReturnType<SlackSkeletonChannelBoundary["normalizeInbound"]>["identity"]): AgentRoute {
  return {
    identity,
    sessionKey: buildSessionKey(identity),
    storagePartitionKey: buildStoragePartitionKey(identity),
    accountId: identity.userId,
    peer: identity.channelId,
    providerId: "anthropic",
  };
}

describe("SlackSkeletonChannelBoundary", () => {
  afterEach(() => {
    delete process.env.SLACK_SKELETON_ENABLED;
    delete process.env.SLACK_ALLOWED_TENANTS;
  });

  test("is disabled by default behind feature flag", () => {
    const boundary = loadSlackSkeletonBoundaryFromEnv();
    expect(boundary).toBeNull();
  });

  test("loads from env when feature flag is enabled", () => {
    process.env.SLACK_SKELETON_ENABLED = "true";
    process.env.SLACK_ALLOWED_TENANTS = "team-1,team-2";
    const boundary = loadSlackSkeletonBoundaryFromEnv();
    expect(boundary).not.toBeNull();
    expect(boundary?.channelType).toBe("slack");
  });

  test("enforces tenant allowlist at boundary identity layer", () => {
    const boundary = new SlackSkeletonChannelBoundary({
      allowedTenants: ["team-allowed"],
    });

    const accepted = boundary.normalizeInbound({
      teamId: "team-allowed",
      channelId: "C001",
      threadTs: "1738200.0001",
      userId: "U001",
      text: "hello",
      ts: "1738200.0002",
    });
    expect(accepted.identity.tenantId as string).toBe("team-allowed");

    expect(() =>
      boundary.normalizeInbound({
        teamId: "team-denied",
        channelId: "C001",
        userId: "U001",
        text: "hello",
        ts: "1738200.0002",
      })
    ).toThrow();
  });

  test("supports skeleton no-op outbound when not wired to runtime", async () => {
    const boundary = new SlackSkeletonChannelBoundary();
    const inbound = boundary.normalizeInbound({
      teamId: "team-1",
      channelId: "C001",
      userId: "U001",
      text: "hello",
      ts: "1738200.0002",
    });
    const route = buildRoute(inbound.identity);

    const payload: ChannelOutboundPayload = {
      type: "text",
      route,
      text: "outbound",
    };

    const receipt = await boundary.deliverOutbound(payload);
    expect(receipt.messageId).toBe("slack-skeleton-noop");
  });

  test("can send text/thread through unified outbound payload contract", async () => {
    const sent: Array<{ channelId: string; text: string; threadTs?: string }> = [];
    const boundary = new SlackSkeletonChannelBoundary({
      outboundPort: {
        sendText: async (channelId, text, threadTs) => {
          sent.push({ channelId, text, threadTs });
          return "ts-1";
        },
        sendReaction: async () => {},
      },
    });

    const inbound = boundary.normalizeInbound({
      teamId: "team-1",
      channelId: "C001",
      threadTs: "1738200.0001",
      userId: "U001",
      text: "hello",
      ts: "1738200.0002",
    });
    const route = buildRoute(inbound.identity);
    const orchestrator = new ChannelOutboundOrchestrator(boundary);
    const receipt = await orchestrator.sendStatus(route, "working", "processing");
    expect(receipt.messageId).toBe("ts-1");
    expect(sent[0]?.channelId).toBe("C001");
    expect(sent[0]?.threadTs).toBe("1738200.0001");
    expect(sent[0]?.text).toBe("processing");
  });
});
