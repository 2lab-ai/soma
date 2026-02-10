import { describe, expect, test } from "bun:test";
import { createSessionIdentity } from "../routing/session-key";
import { createProviderOrchestrator } from "./create-orchestrator";
import type {
  ProviderBoundary,
  ProviderEventHandler,
  ProviderQueryHandle,
  ProviderQueryInput,
  ProviderResumeInput,
  ProviderResumeResult,
} from "./types.models";

class FakeProvider implements ProviderBoundary {
  readonly capabilities = {
    supportsResume: false,
    supportsMidStreamInjection: false,
    supportsToolStreaming: false,
  };

  starts = 0;
  private remainingFailures: number;

  constructor(
    readonly providerId: string,
    failTimes: number = 0
  ) {
    this.remainingFailures = failTimes;
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
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new Error("network timeout");
    }

    await onEvent({
      providerId: this.providerId,
      queryId: handle.queryId,
      timestamp: Date.now(),
      type: "text",
      delta: "ok",
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

  async resumeSession(_input: ProviderResumeInput): Promise<ProviderResumeResult> {
    return {
      providerSessionId: `${this.providerId}-resume`,
      resumed: false,
    };
  }
}

describe("createProviderOrchestrator", () => {
  test("registers default providers when no overrides are passed", () => {
    const orchestrator = createProviderOrchestrator();
    const providerIds = orchestrator.listProviders().sort();
    expect(providerIds).toEqual(["anthropic", "codex"]);
  });

  test("supports app-level provider and retry policy overrides", async () => {
    const flakyAnthropic = new FakeProvider("anthropic", 2);
    const backoffs: number[] = [];
    const orchestrator = createProviderOrchestrator({
      providers: [flakyAnthropic],
      retryPolicies: {
        anthropic: { maxRetries: 2, baseBackoffMs: 1 },
      },
      sleep: async (ms: number) => {
        backoffs.push(ms);
      },
    });

    const result = await orchestrator.executeProviderQuery({
      primaryProviderId: "anthropic",
      input: {
        queryId: "q-create-orchestrator",
        identity: createSessionIdentity({
          tenantId: "tenant-a",
          channelId: "telegram",
          threadId: "thread-1",
        }),
        prompt: "hello",
      },
      onEvent: async () => {},
    });

    expect(result.providerId).toBe("anthropic");
    expect(result.attempts).toBe(3);
    expect(backoffs).toEqual([1, 2]);
    expect(flakyAnthropic.starts).toBe(3);
  });
});
