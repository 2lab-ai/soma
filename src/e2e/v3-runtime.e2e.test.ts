import { afterEach, describe, expect, test } from "bun:test";
import type { Context } from "grammy";
import { existsSync } from "fs";
import { rm } from "fs/promises";
import { join } from "path";
import {
  TelegramChannelBoundary,
  buildTelegramAgentRoute,
} from "../adapters/telegram/channel-boundary";
import { ChannelOutboundOrchestrator } from "../channels/outbound-orchestrator";
import { ProviderOrchestrator } from "../providers/orchestrator";
import { ProviderRegistry } from "../providers/registry";
import type {
  ProviderBoundary,
  ProviderEventHandler,
  ProviderQueryHandle,
  ProviderQueryInput,
  ProviderResumeInput,
  ProviderResumeResult,
} from "../providers/types.models";
import {
  buildSessionKey,
  buildStoragePartitionKey,
  createSessionIdentity,
} from "../routing/session-key";
import { buildSchedulerRoute } from "../scheduler/route";
import {
  configureSchedulerRuntime,
  getSchedulerRuntime,
  resetSchedulerRuntimeForTests,
} from "../scheduler/runtime-boundary";
import { ChatCaptureService } from "../services/chat-capture-service";
import { ChatSearchService } from "../services/chat-search-service";
import { sessionManager } from "../core/session/session-manager";
import { FileChatStorage } from "../storage/chat-storage";

function createTelegramContext({
  chatId,
  threadId,
  text = "hello",
  timestampSeconds = 1700000000,
}: {
  chatId: number;
  threadId: number;
  text?: string;
  timestampSeconds?: number;
}): Context {
  return {
    from: {
      id: 1,
      username: "tester",
    },
    chat: {
      id: chatId,
      type: "private",
    },
    message: {
      text,
      message_id: 10,
      message_thread_id: threadId,
      date: timestampSeconds,
    },
  } as unknown as Context;
}

class FakeProvider implements ProviderBoundary {
  readonly capabilities = {
    supportsResume: true,
    supportsMidStreamInjection: false,
    supportsToolStreaming: false,
  };

  constructor(
    readonly providerId: string,
    private readonly options: {
      failWithRateLimit?: boolean;
      text?: string;
    } = {}
  ) {}

  async startQuery(input: ProviderQueryInput): Promise<ProviderQueryHandle> {
    return {
      queryId: input.queryId,
      providerSessionId: `${this.providerId}-${input.queryId}`,
    };
  }

  async streamEvents(
    handle: ProviderQueryHandle,
    onEvent: ProviderEventHandler
  ): Promise<void> {
    if (this.options.failWithRateLimit) {
      throw new Error("429 rate limit");
    }

    await onEvent({
      providerId: this.providerId,
      queryId: handle.queryId,
      timestamp: Date.now(),
      type: "text",
      delta: this.options.text ?? `${this.providerId}-ok`,
    });
    await onEvent({
      providerId: this.providerId,
      queryId: handle.queryId,
      timestamp: Date.now(),
      type: "done",
      reason: "completed",
    });
  }

  async abortQuery(_handle: ProviderQueryHandle): Promise<void> {}

  async resumeSession(input: ProviderResumeInput): Promise<ProviderResumeResult> {
    return {
      providerSessionId: input.providerSessionId,
      resumed: true,
    };
  }
}

describe("v3 runtime e2e by feature", () => {
  afterEach(() => {
    resetSchedulerRuntimeForTests();
  });

  test("feature/channel+route: telegram inbound -> canonical session key -> unified outbound", async () => {
    const sentTexts: string[] = [];
    const sentReactions: string[] = [];
    const chatId = 55001;
    const threadId = 77;

    const boundary = new TelegramChannelBoundary({
      authorize: () => true,
      checkRateLimit: () => [true],
      outboundPort: {
        sendText: async (_chat, text) => {
          sentTexts.push(text);
          return 500;
        },
        sendReaction: async (_chat, _messageId, reaction) => {
          sentReactions.push(reaction);
        },
      },
    });

    const inbound = boundary.normalizeInbound({
      ctx: createTelegramContext({ chatId, threadId }),
    });
    const route = buildTelegramAgentRoute(inbound);
    const orchestrator = new ChannelOutboundOrchestrator(boundary);

    expect(route.sessionKey as string).toBe(sessionManager.deriveKey(chatId, threadId));

    await orchestrator.sendStatus(route, "working", "processing");
    await orchestrator.sendChoice(route, {
      question: "Pick one",
      choices: [{ id: "a", label: "Option A" }],
    });
    await orchestrator.sendReaction(route, inbound.identity.messageId, "👌");

    expect(sentTexts).toEqual(["processing", "Pick one\n\n1. Option A"]);
    expect(sentReactions).toEqual(["👌"]);
  });

  test("feature/channel policy: out-of-order non-interrupt is dropped but interrupt bypasses", () => {
    const boundary = new TelegramChannelBoundary({
      authorize: () => true,
      checkRateLimit: () => [true],
      outboundPort: {
        sendText: async () => 1,
        sendReaction: async () => {},
      },
    });

    boundary.normalizeInbound({
      ctx: createTelegramContext({
        chatId: 88001,
        threadId: 9,
        text: "first",
        timestampSeconds: 2_000,
      }),
    });

    expect(() =>
      boundary.normalizeInbound({
        ctx: createTelegramContext({
          chatId: 88001,
          threadId: 9,
          text: "older",
          timestampSeconds: 1_999,
        }),
      })
    ).toThrow();

    const interruptInbound = boundary.normalizeInbound({
      ctx: createTelegramContext({
        chatId: 88001,
        threadId: 9,
        text: "!stop",
        timestampSeconds: 1_998,
      }),
    });

    expect(interruptInbound.isInterrupt).toBe(true);
    expect(interruptInbound.metadata.interruptBypassApplied).toBe(true);
  });

  test("feature/provider+channel: provider fallback stream dispatches through outbound orchestrator", async () => {
    const sentTexts: string[] = [];
    const registry = new ProviderRegistry();
    registry.register(
      new FakeProvider("anthropic", {
        failWithRateLimit: true,
      })
    );
    registry.register(
      new FakeProvider("codex", {
        text: "fallback response",
      })
    );
    const providerOrchestrator = new ProviderOrchestrator(registry, {
      retryPolicies: {
        anthropic: { maxRetries: 0, baseBackoffMs: 1 },
      },
    });

    const boundary = new TelegramChannelBoundary({
      authorize: () => true,
      checkRateLimit: () => [true],
      outboundPort: {
        sendText: async (_chat, text) => {
          sentTexts.push(text);
          return 601;
        },
        sendReaction: async () => {},
      },
    });

    const identity = createSessionIdentity({
      tenantId: "default",
      channelId: "8888",
      threadId: "main",
    });
    const route = {
      identity,
      sessionKey: buildSessionKey(identity),
      storagePartitionKey: buildStoragePartitionKey(identity),
      accountId: "1",
      peer: "8888",
      providerId: "anthropic",
    };
    const outbound = new ChannelOutboundOrchestrator(boundary);

    const result = await providerOrchestrator.executeProviderQuery({
      primaryProviderId: "anthropic",
      fallbackProviderId: "codex",
      input: {
        queryId: "q-e2e-fallback",
        identity,
        prompt: "hello",
      },
      onEvent: async (event) => {
        if (event.type === "text") {
          await outbound.sendText(route, event.delta);
        }
      },
    });

    expect(result.providerId).toBe("codex");
    expect(sentTexts).toEqual(["fallback response"]);
  });

  test("feature/storage: capture + partitioned search works with canonical session key", async () => {
    const testDir = `/tmp/soma-v3-e2e-storage-${Date.now()}`;
    const storage = new FileChatStorage(testDir);
    const capture = new ChatCaptureService(storage);
    const search = new ChatSearchService(storage);
    const chatId = 99001;
    const threadId = 13;
    const sessionKey = sessionManager.deriveKey(chatId, threadId);
    const partitionKey = `default/${chatId}/${threadId}`;

    await capture.captureUserMessage(
      sessionKey,
      "claude-session-a",
      "claude-sonnet-4-5",
      "first question"
    );
    await capture.captureAssistantMessage(
      sessionKey,
      "claude-session-a",
      "claude-sonnet-4-5",
      "first answer"
    );

    const sessionResults = await search.searchInSession(sessionKey, { limit: 10 });
    expect(sessionResults.length).toBe(2);
    expect(sessionResults.map((record) => record.speaker).sort()).toEqual([
      "assistant",
      "user",
    ]);

    const today = new Date();
    const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
      today.getDate()
    ).padStart(2, "0")}.ndjson`;
    const expectedPath = join(testDir, "chats", ...partitionKey.split("/"), dateKey);
    expect(existsSync(expectedPath)).toBe(true);

    await rm(testDir, { recursive: true, force: true });
  });

  test("feature/scheduler: route + runtime boundary execute contract-safe key", async () => {
    const route = buildSchedulerRoute("Daily Summary");
    const capturedRequests: Array<{ sessionKey: string; prompt: string }> = [];

    configureSchedulerRuntime({
      isBusy: () => false,
      execute: async (request) => {
        capturedRequests.push({
          sessionKey: request.sessionKey,
          prompt: request.prompt,
        });
        return "ok";
      },
    });

    const runtime = getSchedulerRuntime();
    const result = await runtime.execute({
      prompt: "run now",
      sessionKey: route.sessionKey,
      userId: 1,
      statusCallback: async () => {},
      modelContext: "cron",
    });

    expect(result).toBe("ok");
    expect(capturedRequests).toEqual([
      {
        sessionKey: "cron:scheduler:daily-summary",
        prompt: "run now",
      },
    ]);
  });
});
