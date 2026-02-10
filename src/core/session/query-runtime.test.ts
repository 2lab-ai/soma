import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createSessionIdentity } from "../routing/session-key";
import {
  buildQueryRuntimeMetadata,
  buildQueryRuntimeOptions,
  createQueryRuntimeHooks,
  executeQueryRuntime,
} from "./query-runtime";

function toAsyncGenerator(messages: SDKMessage[]): AsyncGenerator<SDKMessage> {
  return (async function* () {
    for (const message of messages) {
      yield message;
    }
  })();
}

describe("query-runtime hooks", () => {
  test("pre hook blocks tool execution when stop was requested", async () => {
    const hooks = createQueryRuntimeHooks({
      getStopRequested: () => true,
      getSteeringCount: () => 0,
      trackBufferedMessagesForInjection: () => 0,
      consumeSteering: () => null,
      getInjectedCount: () => 0,
    });

    await expect(
      hooks.preToolUseHook({ tool_name: "Bash" }, null, null)
    ).rejects.toThrow("Abort requested by user");
  });

  test("post hook injects steering payload when buffered messages exist", async () => {
    const hooks = createQueryRuntimeHooks({
      getStopRequested: () => false,
      getSteeringCount: () => 2,
      trackBufferedMessagesForInjection: () => 2,
      consumeSteering: () => "[12:00:00] hello",
      getInjectedCount: () => 2,
    });

    const payload = await hooks.postToolUseHook({ tool_name: "Read" }, null, null);
    expect(payload).toEqual({
      systemMessage:
        "[USER SENT MESSAGE DURING EXECUTION]\n[12:00:00] hello\n[END USER MESSAGE]",
    });
  });
});

describe("query-runtime options", () => {
  test("builds Claude query options with tool hooks and abort controller", () => {
    const abortController = new AbortController();
    const hooks = createQueryRuntimeHooks({
      getStopRequested: () => false,
      getSteeringCount: () => 0,
      trackBufferedMessagesForInjection: () => 0,
      consumeSteering: () => null,
      getInjectedCount: () => 0,
    });

    const options = buildQueryRuntimeOptions({
      model: "claude-opus-4-6",
      cwd: "/tmp",
      systemPrompt: "system",
      mcpServers: {},
      maxThinkingTokens: 10000,
      additionalDirectories: ["/tmp"],
      resumeSessionId: "session-1",
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      abortController,
      hooks,
    });

    expect(options.model).toBe("claude-opus-4-6");
    expect(options.resume).toBe("session-1");
    expect(options.abortController).toBe(abortController);
    expect(options.pathToClaudeCodeExecutable).toBe("/usr/local/bin/claude");
    expect(options.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
    expect(options.hooks?.PostToolUse?.[0]?.hooks).toHaveLength(1);
  });
});

describe("query-runtime execution", () => {
  test("streams assistant events and returns usage/tool timing summary", async () => {
    const statusEvents: Array<{ type: string; content: string }> = [];
    const sessionIds: string[] = [];
    const toolDisplays: string[] = [];
    const queryGeneration = 1;

    const events: SDKMessage[] = [
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
              text: "hello world from query runtime stream",
            },
          ],
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

    const result = await executeQueryRuntime({
      prompt: "hello",
      options: {
        model: "claude-opus-4-6",
        cwd: "/tmp",
        abortController: new AbortController(),
      },
      statusCallback: async (type, content) => {
        statusEvents.push({ type, content });
      },
      queryGeneration,
      getCurrentGeneration: () => queryGeneration,
      shouldStop: () => false,
      onSessionId: (sessionId: string) => {
        sessionIds.push(sessionId);
      },
      onToolDisplay: (toolDisplay: string) => {
        toolDisplays.push(toolDisplay);
      },
      onRefreshContextWindowUsageFromTranscript: async () => null,
      queryStartedMs: Date.now(),
      queryFactory: () => toAsyncGenerator(events),
    });

    expect(sessionIds).toEqual(["session-1"]);
    expect(toolDisplays).toHaveLength(1);
    expect(statusEvents.some((event) => event.type === "tool")).toBe(true);
    expect(statusEvents.some((event) => event.type === "text")).toBe(true);
    expect(result.fullResponse).toBe("hello world from query runtime stream");
    expect(result.toolDurations.Read?.count).toBe(1);
    expect(result.contextWindowSize).toBe(200000);
    expect(result.lastUsage).toEqual({
      input_tokens: 12,
      output_tokens: 6,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
    });
    expect(result.queryCompleted).toBe(true);
  });

  test("drops session id when generation changed mid-query", async () => {
    let observedSessionId: string | null = null;
    const queryGeneration = 1;
    const events: SDKMessage[] = [
      {
        type: "assistant",
        session_id: "session-ignored",
        message: { content: [] },
      } as unknown as SDKMessage,
    ];

    const result = await executeQueryRuntime({
      prompt: "hello",
      options: {
        model: "claude-opus-4-6",
        cwd: "/tmp",
        abortController: new AbortController(),
      },
      statusCallback: async () => {},
      queryGeneration,
      getCurrentGeneration: () => queryGeneration + 1,
      shouldStop: () => false,
      onSessionId: (sessionId: string) => {
        observedSessionId = sessionId;
      },
      onToolDisplay: () => {},
      onRefreshContextWindowUsageFromTranscript: async () => null,
      queryStartedMs: Date.now(),
      queryFactory: () => toAsyncGenerator(events),
    });

    expect(observedSessionId).toBeNull();
    expect(result.fullResponse).toBe("No response from Claude.");
    expect(result.queryCompleted).toBe(false);
  });

  test("routes production runtime through provider orchestrator when configured", async () => {
    const executeCalls: Array<{
      primaryProviderId: string;
      fallbackProviderId?: string;
      prompt: string;
    }> = [];

    const orchestrator = {
      executeProviderQuery: async (params: {
        primaryProviderId: string;
        fallbackProviderId?: string;
        input: { prompt: string; queryId: string };
        onEvent: (event: {
          providerId: string;
          queryId: string;
          timestamp: number;
          type: string;
          providerSessionId?: string;
          resumed?: boolean;
          delta?: string;
          reason?: "completed" | "aborted" | "failed";
        }) => Promise<void>;
      }) => {
        executeCalls.push({
          primaryProviderId: params.primaryProviderId,
          fallbackProviderId: params.fallbackProviderId,
          prompt: params.input.prompt,
        });

        await params.onEvent({
          providerId: "codex",
          queryId: params.input.queryId,
          timestamp: Date.now(),
          type: "session",
          providerSessionId: "provider-session",
          resumed: false,
        });
        await params.onEvent({
          providerId: "codex",
          queryId: params.input.queryId,
          timestamp: Date.now(),
          type: "text",
          delta: "fallback text from provider orchestrator runtime",
        });
        await params.onEvent({
          providerId: "codex",
          queryId: params.input.queryId,
          timestamp: Date.now(),
          type: "done",
          reason: "completed",
        });

        return { providerId: "codex", attempts: 1 };
      },
    } as const;

    const observedSessionIds: string[] = [];
    const statusEvents: string[] = [];
    const result = await executeQueryRuntime({
      prompt: "hello from orchestrator runtime",
      options: {
        model: "claude-opus-4-6",
        cwd: "/tmp",
        abortController: new AbortController(),
      },
      statusCallback: async (type) => {
        statusEvents.push(type);
      },
      queryGeneration: 1,
      getCurrentGeneration: () => 1,
      shouldStop: () => false,
      onSessionId: (sessionId: string) => {
        observedSessionIds.push(sessionId);
      },
      onToolDisplay: () => {},
      onRefreshContextWindowUsageFromTranscript: async () => null,
      queryStartedMs: Date.now(),
      providerExecution: {
        orchestrator:
          orchestrator as unknown as import("../../providers/orchestrator").ProviderOrchestrator,
        identity: createSessionIdentity({
          tenantId: "default",
          channelId: "chat-1",
          threadId: "main",
        }),
        primaryProviderId: "anthropic",
        fallbackProviderId: "codex",
      },
    });

    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]).toEqual({
      primaryProviderId: "anthropic",
      fallbackProviderId: "codex",
      prompt: "hello from orchestrator runtime",
    });
    expect(observedSessionIds).toEqual(["provider-session"]);
    expect(statusEvents.some((type) => type === "text")).toBe(true);
    expect(result.providerId).toBe("codex");
    expect(result.fullResponse).toBe(
      "fallback text from provider orchestrator runtime"
    );
    expect(result.queryCompleted).toBe(true);
  });
});

describe("query-runtime metadata", () => {
  test("builds metadata with duration and provider info", () => {
    const metadata = buildQueryRuntimeMetadata({
      usageBefore: { fiveHour: 10, sevenDay: 20 },
      usageAfter: { fiveHour: 11, sevenDay: 21 },
      toolDurations: { Read: { count: 1, totalMs: 30 } },
      queryStartedMs: 1000,
      queryEndedMs: 1250,
      contextUsagePercent: 52,
      contextUsagePercentBefore: 49,
      modelDisplayName: "Claude Opus",
    });

    expect(metadata.queryDurationMs).toBe(250);
    expect(metadata.currentProvider).toBe("anthropic");
    expect(metadata.modelDisplayName).toBe("Claude Opus");
    expect(metadata.toolDurations.Read?.count).toBe(1);
  });
});
