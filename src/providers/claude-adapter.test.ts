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
    modelId: "claude-opus-4-6",
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

  test("context event: single-turn query reports accurate context %", async () => {
    // Scenario: simple 1-turn query, no tool use.
    // modelUsage: input=500, cacheRead=850000, cacheCreate=50000 → total billing = 900500
    // num_turns=1 → estimated = 900500 / 1 = 900500
    // contextWindow=200000 (SDK default, session layer corrects to 1M)
    const mockEvents: SDKMessage[] = [
      {
        type: "assistant",
        session_id: "session-ctx-1",
        message: { content: [{ type: "text", text: "ok" }] },
      } as unknown as SDKMessage,
      {
        type: "result",
        num_turns: 1,
        modelUsage: {
          "claude-opus-4-6": {
            inputTokens: 500,
            outputTokens: 2000,
            cacheReadInputTokens: 850000,
            cacheCreationInputTokens: 50000,
            contextWindow: 200000,
          },
        },
      } as unknown as SDKMessage,
    ];

    const adapter = new ClaudeProviderAdapter(() => toAsyncGenerator(mockEvents));
    const events: ProviderEvent[] = [];
    const handle = await adapter.startQuery(createInput("q-ctx-1"));
    await adapter.streamEvents(handle, (event) => events.push(event));

    const contextEvent = events.find((e) => e.type === "context");
    expect(contextEvent).toBeDefined();
    if (contextEvent?.type === "context") {
      // 1 turn: exact = 500 + 850000 + 50000 = 900500
      expect(contextEvent.usedTokens).toBe(900500);
      expect(contextEvent.maxTokens).toBe(200000);
    }
  });

  test("context event: multi-turn query divides by num_turns", async () => {
    // Scenario: 5-turn query (tool use loop).
    // Each turn context ≈ 100K. cumulative ≈ 500K.
    // modelUsage: input=2500, cacheRead=450000, cacheCreate=50000 → cumulative = 502500
    // num_turns=5 → estimated = 502500 / 5 = 100500
    const mockEvents: SDKMessage[] = [
      {
        type: "assistant",
        session_id: "session-ctx-2",
        message: { content: [{ type: "text", text: "done" }] },
      } as unknown as SDKMessage,
      {
        type: "result",
        num_turns: 5,
        modelUsage: {
          "claude-opus-4-6": {
            inputTokens: 2500,
            outputTokens: 10000,
            cacheReadInputTokens: 450000,
            cacheCreationInputTokens: 50000,
            contextWindow: 200000,
          },
        },
      } as unknown as SDKMessage,
    ];

    const adapter = new ClaudeProviderAdapter(() => toAsyncGenerator(mockEvents));
    const events: ProviderEvent[] = [];
    const handle = await adapter.startQuery(createInput("q-ctx-2"));
    await adapter.streamEvents(handle, (event) => events.push(event));

    const contextEvent = events.find((e) => e.type === "context");
    expect(contextEvent).toBeDefined();
    if (contextEvent?.type === "context") {
      // 502500 / 5 = 100500
      expect(contextEvent.usedTokens).toBe(100500);
      expect(contextEvent.maxTokens).toBe(200000);
    }
  });

  test("context event: original bug scenario (14 turns, was showing 2826%)", async () => {
    // Real production data that showed 2826% before fix.
    // cumulative = 5652204 (14 turns)
    // OLD behavior: usedTokens=5652204, maxTokens=200000 → 2826%
    // NEW behavior: usedTokens=5652204/14=403729, maxTokens=200000 → 201%
    //   (session layer then corrects maxTokens to 1M → 40.4%)
    const mockEvents: SDKMessage[] = [
      {
        type: "assistant",
        session_id: "session-ctx-3",
        message: { content: [{ type: "text", text: "done" }] },
      } as unknown as SDKMessage,
      {
        type: "result",
        num_turns: 14,
        modelUsage: {
          "claude-opus-4-6": {
            inputTokens: 7000,
            outputTokens: 50000,
            cacheReadInputTokens: 5000000,
            cacheCreationInputTokens: 645204,
            contextWindow: 200000,
          },
        },
      } as unknown as SDKMessage,
    ];

    const adapter = new ClaudeProviderAdapter(() => toAsyncGenerator(mockEvents));
    const events: ProviderEvent[] = [];
    const handle = await adapter.startQuery(createInput("q-ctx-3"));
    await adapter.streamEvents(handle, (event) => events.push(event));

    const contextEvent = events.find((e) => e.type === "context");
    expect(contextEvent).toBeDefined();
    if (contextEvent?.type === "context") {
      // (7000 + 5000000 + 645204) / 14 = 403729 (rounded)
      const expected = Math.round((7000 + 5000000 + 645204) / 14);
      expect(contextEvent.usedTokens).toBe(expected);
      // No longer 2826%! At 200K window: 201%. At 1M (session-corrected): 40.4%
      expect(contextEvent.usedTokens).toBeLessThan(1000000);
    }
  });

  test("context event: num_turns=0 or missing defaults to 1", async () => {
    // Edge case: result event without num_turns field
    const mockEvents: SDKMessage[] = [
      {
        type: "assistant",
        session_id: "session-ctx-4",
        message: { content: [{ type: "text", text: "ok" }] },
      } as unknown as SDKMessage,
      {
        type: "result",
        // num_turns missing!
        modelUsage: {
          "claude-opus-4-6": {
            inputTokens: 100,
            outputTokens: 500,
            cacheReadInputTokens: 50000,
            cacheCreationInputTokens: 10000,
            contextWindow: 200000,
          },
        },
      } as unknown as SDKMessage,
    ];

    const adapter = new ClaudeProviderAdapter(() => toAsyncGenerator(mockEvents));
    const events: ProviderEvent[] = [];
    const handle = await adapter.startQuery(createInput("q-ctx-4"));
    await adapter.streamEvents(handle, (event) => events.push(event));

    const contextEvent = events.find((e) => e.type === "context");
    expect(contextEvent).toBeDefined();
    if (contextEvent?.type === "context") {
      // num_turns defaults to 1 → no division
      expect(contextEvent.usedTokens).toBe(60100);
      expect(contextEvent.maxTokens).toBe(200000);
    }
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
