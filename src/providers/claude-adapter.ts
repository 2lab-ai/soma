import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderBoundary,
  ProviderEventHandler,
  ProviderQueryHandle,
  ProviderQueryInput,
  ProviderResumeInput,
  ProviderResumeResult,
} from "./types.models";
import { normalizeProviderError } from "./error-normalizer";

type ClaudeQueryFactory = (payload: {
  prompt: string;
  options: Options & { abortController: AbortController };
}) => AsyncGenerator<SDKMessage>;

interface ActiveClaudeQuery {
  input: ProviderQueryInput;
  abortController: AbortController;
}

interface ClaudeModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextWindow: number;
}

function safeNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function hasUsageData(value: {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}): boolean {
  return (
    value.inputTokens > 0 ||
    value.outputTokens > 0 ||
    (value.cacheReadInputTokens ?? 0) > 0 ||
    (value.cacheCreationInputTokens ?? 0) > 0
  );
}

function toClaudeOptions(
  input: ProviderQueryInput,
  abortController: AbortController
): Options & { abortController: AbortController } {
  const permissionMode =
    input.permissionMode === "bypass" ? "bypassPermissions" : undefined;

  return {
    model: input.modelId,
    cwd: input.workingDirectory,
    systemPrompt: input.systemPrompt,
    mcpServers: input.mcpServers as Options["mcpServers"],
    maxThinkingTokens: input.maxThinkingTokens,
    additionalDirectories: input.additionalDirectories
      ? [...input.additionalDirectories]
      : undefined,
    resume: input.resumeSessionId,
    permissionMode,
    allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions ?? true,
    hooks: input.hooks as Options["hooks"],
    pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable,
    abortController,
  };
}

export class ClaudeProviderAdapter implements ProviderBoundary {
  readonly providerId = "anthropic";
  readonly capabilities = {
    supportsResume: true,
    supportsMidStreamInjection: true,
    supportsToolStreaming: true,
  };

  private readonly activeQueries = new Map<string, ActiveClaudeQuery>();
  private readonly queryFactory: ClaudeQueryFactory;

  constructor(queryFactory: ClaudeQueryFactory = query) {
    this.queryFactory = queryFactory;
  }

  async startQuery(input: ProviderQueryInput): Promise<ProviderQueryHandle> {
    const abortController = input.abortController ?? new AbortController();
    this.activeQueries.set(input.queryId, { input, abortController });
    return {
      queryId: input.queryId,
      providerSessionId: input.resumeSessionId,
    };
  }

  async streamEvents(
    handle: ProviderQueryHandle,
    onEvent: ProviderEventHandler
  ): Promise<void> {
    const active = this.activeQueries.get(handle.queryId);
    if (!active) {
      throw normalizeProviderError(
        this.providerId,
        new Error(`Unknown query handle: ${handle.queryId}`)
      );
    }

    const input = active.input;

    try {
      const queryInstance = this.queryFactory({
        prompt: input.prompt,
        options: toClaudeOptions(input, active.abortController),
      });

      for await (const event of queryInstance) {
        const timestamp = Date.now();

        if (event.session_id) {
          await onEvent({
            providerId: this.providerId,
            queryId: handle.queryId,
            timestamp,
            type: "session",
            providerSessionId: event.session_id,
            resumed: Boolean(input.resumeSessionId),
          });
        }

        if (event.type === "stream_event") {
          const raw = event.event;
          const usage: unknown =
            raw.type === "message_start"
              ? raw.message.usage
              : raw.type === "message_delta"
                ? raw.usage
                : null;
          if (usage && typeof usage === "object") {
            const usageRecord = usage as Record<string, unknown>;
            const normalizedUsage = {
              inputTokens: safeNumber(usageRecord.input_tokens),
              outputTokens: safeNumber(usageRecord.output_tokens),
              cacheReadInputTokens: safeNumber(usageRecord.cache_read_input_tokens),
              cacheCreationInputTokens: safeNumber(
                usageRecord.cache_creation_input_tokens
              ),
            };
            if (hasUsageData(normalizedUsage)) {
              await onEvent({
                providerId: this.providerId,
                queryId: handle.queryId,
                timestamp,
                type: "usage",
                usage: normalizedUsage,
              });
            }
          }
          continue;
        }

        if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "tool_use") {
              await onEvent({
                providerId: this.providerId,
                queryId: handle.queryId,
                timestamp: Date.now(),
                type: "tool",
                toolName: block.name,
                phase: "start",
                payload: block.input,
              });
              continue;
            }
            if (block.type === "text") {
              await onEvent({
                providerId: this.providerId,
                queryId: handle.queryId,
                timestamp: Date.now(),
                type: "text",
                delta: block.text,
              });
            }
          }
          continue;
        }

        if (event.type === "result") {
          if ("modelUsage" in event && event.modelUsage) {
            const modelUsage = event.modelUsage as Record<string, ClaudeModelUsage>;
            let totalInput = 0;
            let totalOutput = 0;
            let totalCacheRead = 0;
            let totalCacheCreate = 0;
            let contextWindow = 0;

            for (const usage of Object.values(modelUsage)) {
              totalInput += safeNumber(usage?.inputTokens);
              totalOutput += safeNumber(usage?.outputTokens);
              totalCacheRead += safeNumber(usage?.cacheReadInputTokens);
              totalCacheCreate += safeNumber(usage?.cacheCreationInputTokens);
              contextWindow = Math.max(contextWindow, safeNumber(usage?.contextWindow));
            }

            const normalizedUsage = {
              inputTokens: totalInput,
              outputTokens: totalOutput,
              cacheReadInputTokens: totalCacheRead,
              cacheCreationInputTokens: totalCacheCreate,
            };
            if (hasUsageData(normalizedUsage)) {
              await onEvent({
                providerId: this.providerId,
                queryId: handle.queryId,
                timestamp: Date.now(),
                type: "usage",
                usage: normalizedUsage,
              });
            }

            if (contextWindow > 0) {
              await onEvent({
                providerId: this.providerId,
                queryId: handle.queryId,
                timestamp: Date.now(),
                type: "context",
                usedTokens: totalInput + totalCacheRead + totalCacheCreate,
                maxTokens: contextWindow,
              });
            }
          }

          await onEvent({
            providerId: this.providerId,
            queryId: handle.queryId,
            timestamp: Date.now(),
            type: "done",
            reason: "completed",
          });
        }
      }
    } catch (error) {
      const normalizedError = normalizeProviderError(this.providerId, error);

      if (normalizedError.code === "RATE_LIMIT") {
        await onEvent({
          providerId: this.providerId,
          queryId: handle.queryId,
          timestamp: Date.now(),
          type: "rate_limit",
          statusCode: normalizedError.statusCode,
        });
      }

      await onEvent({
        providerId: this.providerId,
        queryId: handle.queryId,
        timestamp: Date.now(),
        type: "done",
        reason: "failed",
        errorMessage: normalizedError.message,
      });
      throw normalizedError;
    } finally {
      this.activeQueries.delete(handle.queryId);
    }
  }

  async abortQuery(handle: ProviderQueryHandle): Promise<void> {
    const active = this.activeQueries.get(handle.queryId);
    if (active) {
      active.abortController.abort();
      this.activeQueries.delete(handle.queryId);
    }
  }

  async resumeSession(input: ProviderResumeInput): Promise<ProviderResumeResult> {
    return {
      providerSessionId: input.providerSessionId,
      resumed: true,
    };
  }
}
