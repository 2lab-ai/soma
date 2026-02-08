import { expect, test } from "bun:test";
import {
  buildSessionKey,
  buildStoragePartitionKey,
  createSessionIdentity,
  type AgentRoute,
  type ChannelBoundary,
  type ChannelInboundEnvelope,
  type ChannelOutboundPayload,
  type ProviderBoundary,
  type ProviderEvent,
  type RouteResolver,
} from "./index";

const identity = createSessionIdentity({
  tenantId: "tenant-a",
  channelId: "telegram-main",
  threadId: "thread-42",
});

const routeResolver: RouteResolver = (input) => ({
  identity: input.identity,
  sessionKey: buildSessionKey(input.identity),
  storagePartitionKey: buildStoragePartitionKey(input.identity),
  accountId: input.accountId,
  peer: input.peer,
  parentPeer: input.parentPeer,
  providerId: input.preferredProviderId ?? "provider-default",
});

const channelBoundary: ChannelBoundary = {
  channelType: "telegram",
  capabilities: {
    supportsThreads: true,
    supportsReactions: true,
    supportsChoiceKeyboard: true,
  },
  normalizeInbound: async () =>
    ({
      identity: {
        ...identity,
        userId: "user-1",
        messageId: "msg-1",
        timestamp: Date.now(),
      },
      text: "hello",
    }) satisfies ChannelInboundEnvelope,
  deliverOutbound: async (payload) => ({
    messageId: `${payload.type}-message`,
    deliveredAt: Date.now(),
  }),
};

const providerBoundary: ProviderBoundary = {
  providerId: "provider-default",
  capabilities: {
    supportsResume: true,
    supportsMidStreamInjection: false,
    supportsToolStreaming: true,
  },
  startQuery: async (input) => ({
    queryId: input.queryId,
    providerSessionId: "provider-session-1",
  }),
  streamEvents: async (handle, onEvent) => {
    const doneEvent: ProviderEvent = {
      providerId: "provider-default",
      queryId: handle.queryId,
      timestamp: Date.now(),
      type: "done",
      reason: "completed",
    };
    await onEvent(doneEvent);
  },
  abortQuery: async (_handle, _reason) => {},
  resumeSession: async (input) => ({
    providerSessionId: input.providerSessionId,
    resumed: true,
  }),
};

test("contract barrel exposes compile-safe channel/provider/route contracts", async () => {
  const route = (await routeResolver({
    identity,
    channelType: "telegram",
    accountId: "account-1",
    peer: "peer-1",
    preferredProviderId: "provider-default",
  })) satisfies AgentRoute;

  const payload: ChannelOutboundPayload = {
    type: "text",
    route,
    text: "hello world",
  };

  const delivery = await channelBoundary.deliverOutbound(payload);
  expect(delivery.messageId).toBe("text-message");

  const handle = await providerBoundary.startQuery({
    queryId: "query-1",
    identity,
    prompt: "hello provider",
  });

  const events: ProviderEvent[] = [];
  await providerBoundary.streamEvents(handle, (event) => {
    events.push(event);
  });

  expect(events[0]?.type).toBe("done");
  expect(events[0]?.queryId).toBe("query-1");
});
