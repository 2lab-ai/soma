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
