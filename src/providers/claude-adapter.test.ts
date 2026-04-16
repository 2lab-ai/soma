import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeProviderAdapter } from "./claude-adapter";
import type { ProviderEvent } from "./types.models";
import { createSessionIdentity } from "../routing/session-key";
import { NormalizedProviderError } from "./error-normalizer";

function toAsyncGenerator(messages: SDKMessage[]): AsyncGenerator<SDKMessage> {
  return (async function* () {
    for (const message of messages) {
      yield message;
    }
  })();
}

function createInput(queryId: string) {
  return {
    queryId,
    identity: createSessionIdentity({
      tenantId: "tenant-a",
      channelId: "telegram",
      threadId: "thread-1",
    }),
    prompt: "hello",
    modelId: "claude-opus-4-7",
    workingDirectory: "/tmp",
  };
}

describe("ClaudeProviderAdapter", () => {
  test("normalizes Claude SDK events into shared provider DTOs", async () => {
    const mockEvents: SDKMessage[] = [
      {
        type: "assistant",
        session_id: "session-1",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "/tmp/a.ts" },
            },
            {
              type: "text",
              text: "hello",
            },
          ],
        },
      } as unknown as SDKMessage,
      {
        type: "stream_event",
        event: {
          type: "message_delta",
          usage: {
            input_tokens: 10,
            output_tokens: 3,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 1,
          },
        },
      } as unknown as SDKMessage,
      {
        type: "result",
        modelUsage: {
          claude: {
            inputTokens: 12,
            outputTokens: 6,
            cacheReadInputTokens: 2,
            cacheCreationInputTokens: 1,
            contextWindow: 200000,
          },
        },
      } as unknown as SDKMessage,
    ];

    const adapter = new ClaudeProviderAdapter(() => toAsyncGenerator(mockEvents));
    const events: ProviderEvent[] = [];

    const handle = await adapter.startQuery(createInput("q1"));
    await adapter.streamEvents(handle, (event) => {
      events.push(event);
    });

    expect(events.map((event) => event.type)).toEqual([
      "session",
      "tool",
      "text",
      "usage",
      "usage",
      "context",
      "done",
    ]);
    expect(events[0]?.providerId).toBe("anthropic");
    expect(events[events.length - 1]?.type).toBe("done");
  });

  test("BUG soma-wzyw: emits assistant-turn usage and output-inclusive context totals", async () => {
    const mockEvents: SDKMessage[] = [
      {
        type: "system",
        subtype: "init",
        betas: ["context-1m-2025-08-07"],
        session_id: "session-1",
      } as unknown as SDKMessage,
      {
        type: "assistant",
        session_id: "session-1",
        message: {
          usage: {
            input_tokens: 2000,
            output_tokens: 400,
            cache_read_input_tokens: 300,
            cache_creation_input_tokens: 100,
          },
          content: [{ type: "text", text: "hello" }],
        },
      } as unknown as SDKMessage,
      {
        type: "result",
        modelUsage: {
          claude: {
            inputTokens: 4300,
            outputTokens: 900,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            contextWindow: 200000,
          },
        },
      } as unknown as SDKMessage,
    ];

    const adapter = new ClaudeProviderAdapter(() => toAsyncGenerator(mockEvents));
    const events: ProviderEvent[] = [];

    const handle = await adapter.startQuery(createInput("q3"));
    await adapter.streamEvents(handle, (event) => {
      events.push(event);
    });

    const usageEvents = events.filter((event) => event.type === "usage");
    const contextEvent = events.find((event) => event.type === "context");

    expect((usageEvents[0] as any)?.usage).toMatchObject({
      inputTokens: 2000,
      outputTokens: 400,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 100,
      usageKind: "assistant_turn",
    });
    expect((usageEvents[usageEvents.length - 1] as any)?.usage).toMatchObject({
      inputTokens: 4300,
      outputTokens: 900,
      usageKind: "aggregate",
    });
    expect(contextEvent).toMatchObject({
      type: "context",
      usedTokens: 2800,
      maxTokens: 1_000_000,
    });
  });

  test("S3: error result variant emits done:failed with errorMessage and throws", async () => {
    const mockEvents: SDKMessage[] = [
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["billing_error", "quota_exceeded"],
        duration_ms: 100,
        duration_api_ms: 50,
        num_turns: 1,
        total_cost_usd: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        modelUsage: {},
        permission_denials: [],
        session_id: "session-err",
      } as unknown as SDKMessage,
    ];

    const adapter = new ClaudeProviderAdapter(() => toAsyncGenerator(mockEvents));
    const events: ProviderEvent[] = [];

    const handle = await adapter.startQuery(createInput("q-err"));

    // Error result must throw so callers can handle it
    try {
      await adapter.streamEvents(handle, (event) => {
        events.push(event);
      });
      throw new Error("Expected adapter to throw on error result");
    } catch (error) {
      expect(error instanceof NormalizedProviderError).toBe(true);
      const normalized = error as NormalizedProviderError;
      expect(normalized.message).toContain("billing_error");
    }

    // done:failed event should be emitted exactly once (no duplicate)
    const doneEvents = events.filter((event) => event.type === "done");
    expect(doneEvents.length).toBe(1);
    expect(doneEvents[0]!.reason).toBe("failed");
    expect((doneEvents[0] as any).errorMessage).toContain("billing_error");
    expect((doneEvents[0] as any).errorMessage).toContain("quota_exceeded");
  });

  test("S3: success result variant emits done:completed", async () => {
    const mockEvents: SDKMessage[] = [
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        duration_ms: 100,
        duration_api_ms: 50,
        num_turns: 1,
        total_cost_usd: 0.01,
        usage: { inputTokens: 10, outputTokens: 5 },
        modelUsage: {},
        permission_denials: [],
        session_id: "session-ok",
      } as unknown as SDKMessage,
    ];

    const adapter = new ClaudeProviderAdapter(() => toAsyncGenerator(mockEvents));
    const events: ProviderEvent[] = [];

    const handle = await adapter.startQuery(createInput("q-ok"));
    await adapter.streamEvents(handle, (event) => {
      events.push(event);
    });

    const doneEvent = events.find((event) => event.type === "done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent!.reason).toBe("completed");
    expect((doneEvent as any).errorMessage).toBeUndefined();
  });

  test("Opus 4.7: forwards SDK options without maxThinkingTokens (adaptive + xhigh)", async () => {
    const recorded: Array<{ prompt: string; options: unknown }> = [];

    const queryFactory = (payload: { prompt: string; options: unknown }) => {
      recorded.push(payload);
      return toAsyncGenerator([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "ok",
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
          modelUsage: {},
          permission_denials: [],
          session_id: "s",
        } as unknown as SDKMessage,
      ]);
    };

    const adapter = new ClaudeProviderAdapter(queryFactory as any);
    const handle = await adapter.startQuery({
      ...createInput("opus-4-7-wiring"),
      modelId: "claude-opus-4-7",
      maxThinkingTokens: 50000,
    } as any);
    await adapter.streamEvents(handle, () => {});

    expect(recorded.length).toBe(1);
    const opts = recorded[0]!.options as Record<string, unknown>;
    expect(opts.model).toBe("claude-opus-4-7");
    expect(opts.maxThinkingTokens).toBeUndefined();
    expect(opts.thinking).toEqual({ type: "adaptive" });
    expect(opts.effort).toBe("xhigh");
  });

  test("Sonnet 4.5: forwards maxThinkingTokens without adaptive override", async () => {
    const recorded: Array<{ prompt: string; options: unknown }> = [];

    const queryFactory = (payload: { prompt: string; options: unknown }) => {
      recorded.push(payload);
      return toAsyncGenerator([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "ok",
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
          modelUsage: {},
          permission_denials: [],
          session_id: "s",
        } as unknown as SDKMessage,
      ]);
    };

    const adapter = new ClaudeProviderAdapter(queryFactory as any);
    const handle = await adapter.startQuery({
      ...createInput("sonnet-passthrough"),
      modelId: "claude-sonnet-4-5-20250929",
      maxThinkingTokens: 50000,
    } as any);
    await adapter.streamEvents(handle, () => {});

    const opts = recorded[0]!.options as Record<string, unknown>;
    expect(opts.model).toBe("claude-sonnet-4-5-20250929");
    expect(opts.maxThinkingTokens).toBe(50000);
    expect(opts.thinking).toBeUndefined();
    expect(opts.effort).toBeUndefined();
  });

  test("emits normalized rate-limit and failed done events on provider error", async () => {
    const adapter = new ClaudeProviderAdapter(() => {
      throw new Error("429 rate limit exceeded");
    });
    const events: ProviderEvent[] = [];
    const handle = await adapter.startQuery(createInput("q2"));

    try {
      await adapter.streamEvents(handle, (event) => {
        events.push(event);
      });
      throw new Error("Expected adapter to throw");
    } catch (error) {
      expect(error instanceof NormalizedProviderError).toBe(true);
      const normalized = error as NormalizedProviderError;
      expect(normalized.code).toBe("RATE_LIMIT");
    }

    expect(events.some((event) => event.type === "rate_limit")).toBe(true);
    expect(
      events.some((event) => event.type === "done" && event.reason === "failed")
    ).toBe(true);
  });
});
