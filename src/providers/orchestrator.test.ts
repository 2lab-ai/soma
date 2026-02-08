import { describe, expect, test } from "bun:test";
import { ProviderOrchestrator } from "./orchestrator";
import { ProviderRegistry } from "./registry";
import type {
  ProviderBoundary,
  ProviderEvent,
  ProviderEventHandler,
  ProviderQueryHandle,
  ProviderQueryInput,
  ProviderResumeInput,
  ProviderResumeResult,
} from "./types.models";
import { createSessionIdentity } from "../routing/session-key";

interface FakeProviderBehavior {
  failTimes?: number;
  failError?: Error;
  emitText?: string;
}

class FakeProvider implements ProviderBoundary {
  readonly capabilities = {
    supportsResume: true,
    supportsMidStreamInjection: false,
    supportsToolStreaming: false,
  };

  starts = 0;
  streams = 0;

  private remainingFailures: number;

  constructor(
    readonly providerId: string,
    private readonly behavior: FakeProviderBehavior
  ) {
    this.remainingFailures = behavior.failTimes ?? 0;
  }

  async startQuery(input: ProviderQueryInput): Promise<ProviderQueryHandle> {
    this.starts += 1;
    return {
      queryId: input.queryId,
      providerSessionId: `${this.providerId}-${input.queryId}`,
    };
  }

  async streamEvents(
    handle: ProviderQueryHandle,
    onEvent: ProviderEventHandler
  ): Promise<void> {
    this.streams += 1;

    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw this.behavior.failError ?? new Error("provider failed");
    }

    await onEvent({
      providerId: this.providerId,
      queryId: handle.queryId,
      timestamp: Date.now(),
      type: "session",
      providerSessionId: handle.providerSessionId ?? `${this.providerId}-session`,
      resumed: false,
    });
    await onEvent({
      providerId: this.providerId,
      queryId: handle.queryId,
      timestamp: Date.now(),
      type: "text",
      delta: this.behavior.emitText ?? `${this.providerId}:ok`,
    });
    await onEvent({
      providerId: this.providerId,
      queryId: handle.queryId,
      timestamp: Date.now(),
      type: "usage",
      usage: { inputTokens: 1, outputTokens: 1 },
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

function createBaseInput(queryId: string): ProviderQueryInput {
  return {
    queryId,
    identity: createSessionIdentity({
      tenantId: "tenant-a",
      channelId: "telegram",
      threadId: "thread-1",
    }),
    prompt: "hello",
  };
}

describe("ProviderOrchestrator", () => {
  test("provider swap keeps core callsite event shape stable", async () => {
    const registry = new ProviderRegistry();
    const claude = new FakeProvider("anthropic", { emitText: "claude-text" });
    const codex = new FakeProvider("codex", { emitText: "codex-text" });
    registry.register(claude);
    registry.register(codex);

    const orchestrator = new ProviderOrchestrator(registry);
    const run = async (providerId: string): Promise<ProviderEvent[]> => {
      const events: ProviderEvent[] = [];
      await orchestrator.executeProviderQuery({
        primaryProviderId: providerId,
        input: createBaseInput(`q-${providerId}`),
        onEvent: (event) => {
          events.push(event);
        },
      });
      return events;
    };

    const claudeEvents = await run("anthropic");
    const codexEvents = await run("codex");

    expect(claudeEvents.map((event) => event.type)).toEqual([
      "session",
      "text",
      "usage",
      "done",
    ]);
    expect(codexEvents.map((event) => event.type)).toEqual([
      "session",
      "text",
      "usage",
      "done",
    ]);
  });

  test("retries retryable provider failures with backoff", async () => {
    const registry = new ProviderRegistry();
    const flaky = new FakeProvider("anthropic", {
      failTimes: 1,
      failError: new Error("network timeout"),
      emitText: "eventual-success",
    });
    registry.register(flaky);

    const backoffCalls: number[] = [];
    const orchestrator = new ProviderOrchestrator(registry, {
      retryPolicies: {
        anthropic: { maxRetries: 2, baseBackoffMs: 5 },
      },
      sleep: async (ms) => {
        backoffCalls.push(ms);
      },
    });

    const events: ProviderEvent[] = [];
    const result = await orchestrator.executeProviderQuery({
      primaryProviderId: "anthropic",
      input: createBaseInput("q-retry"),
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.providerId).toBe("anthropic");
    expect(result.attempts).toBe(2);
    expect(backoffCalls).toEqual([5]);
    expect(flaky.starts).toBe(2);
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  test("falls back to secondary provider on rate-limit", async () => {
    const registry = new ProviderRegistry();
    const primary = new FakeProvider("anthropic", {
      failTimes: 1,
      failError: new Error("429 rate limit"),
    });
    const fallback = new FakeProvider("codex", { emitText: "fallback-ok" });
    registry.register(primary);
    registry.register(fallback);

    const orchestrator = new ProviderOrchestrator(registry, {
      retryPolicies: {
        anthropic: { maxRetries: 0, baseBackoffMs: 1 },
      },
    });

    const events: ProviderEvent[] = [];
    const result = await orchestrator.executeProviderQuery({
      primaryProviderId: "anthropic",
      fallbackProviderId: "codex",
      input: createBaseInput("q-fallback"),
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.providerId).toBe("codex");
    expect(primary.starts).toBe(1);
    expect(fallback.starts).toBe(1);
    expect(events.some((event) => event.providerId === "codex" && event.type === "done")).toBe(
      true
    );
  });
});
